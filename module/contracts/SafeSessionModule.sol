// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity 0.8.23;

import "hardhat/console.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {HandlerContext} from "@safe-global/safe-contracts/contracts/handler/HandlerContext.sol";
import {CompatibilityFallbackHandler} from "@safe-global/safe-contracts/contracts/handler/CompatibilityFallbackHandler.sol";
import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {UserOperationLib} from "@account-abstraction/contracts/core/UserOperationLib.sol";
import {ISafe} from "./interfaces/Safe.sol";

/**
 * @title Safe4337Module - An extension to the Safe contract that implements the ERC4337 interface.
 * @dev The contract is both a module and fallback handler.
 *      Safe forwards the `validateUserOp` call to this contract, it validates the user operation and returns the result.
 *      It also executes a module transaction to pay the prefund. Similar flow for the actual operation execution.
 *      Security considerations:
 *      - The module is limited to the entry point address specified in the constructor.
 *      - The user operation hash is signed by the Safe owner(s) and validated by the module.
 *      - The user operation is not allowed to execute any other function than `executeUserOp` and `executeUserOpWithErrorString`.
 *      - Replay protection is handled by the entry point.
 * @custom:security-contact bounty@safe.global
 */
contract SafeSessionModule is IAccount, HandlerContext, CompatibilityFallbackHandler {
    using UserOperationLib for PackedUserOperation;

    /**
     * @notice The EIP-712 type-hash for the domain separator used for verifying Safe operation signatures.
     * @dev keccak256("EIP712Domain(uint256 chainId,address verifyingContract)") = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218
     */
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;

    /**
     * @notice The EIP-712 type-hash for a SafeOp, representing the structure of a User Operation for the Safe.
     *  {address} safe - The address of the safe on which the operation is performed.
     *  {uint256} nonce - A unique number associated with the user operation, preventing replay attacks by ensuring each operation is unique.
     *  {bytes} initCode - The packed encoding of a factory address and its factory-specific data for creating a new Safe account.
     *  {bytes} callData - The bytes representing the data of the function call to be executed.
     *  {uint128} verificationGasLimit - The maximum amount of gas allowed for the verification process.
     *  {uint128} callGasLimit - The maximum amount of gas allowed for executing the function call.
     *  {uint256} preVerificationGas - The amount of gas allocated for pre-verification steps before executing the main operation.
     *  {uint128} maxPriorityFeePerGas - The maximum priority fee per gas that the user is willing to pay for the transaction.
     *  {uint128} maxFeePerGas - The maximum fee per gas that the user is willing to pay for the transaction.
     *  {bytes} paymasterAndData - The packed encoding of a paymaster address and its paymaster-specific data for sponsoring the user operation.
     *  {uint48} validAfter - A timestamp representing from when the user operation is valid.
     *  {uint48} validUntil - A timestamp representing until when the user operation is valid, or 0 to indicated "forever".
     *  {address} entryPoint - The address of the entry point that will execute the user operation.
     * @dev When validating the user operation, the signature timestamps are pre-pended to the signature bytes. Equal to:
     * keccak256(
     *     "SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,uint48 validAfter,uint48 validUntil,address entryPoint)"
     * ) = 0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f
     */
    bytes32 private constant SAFE_OP_TYPEHASH = 0xc03dfc11d8b10bf9cf703d558958c8c42777f785d998c62060d85a4f0ef6ea7f;

    /**
     * @dev A structure used internally for manually encoding a Safe operation for when computing the EIP-712 struct hash.
     */
    struct EncodedSafeOpStruct {
        bytes32 typeHash;
        address safe;
        uint256 nonce;
        bytes32 initCodeHash;
        bytes32 callDataHash;
        uint128 verificationGasLimit;
        uint128 callGasLimit;
        uint256 preVerificationGas;
        uint128 maxPriorityFeePerGas;
        uint128 maxFeePerGas;
        bytes32 paymasterAndDataHash;
        uint48 validAfter;
        uint48 validUntil;
        address entryPoint;
    }

    struct Call {
    // The target address for the account to call.
    address target;
    // The value to send with the call.
    uint256 value;
    // The calldata for the call.
    bytes data;
    }

    // SessionKey -> token -> SessionData
    mapping(address => mapping(address => SessionData)) public sessionKeys;

    struct SessionData {

        address account;
        uint48 validAfter;
        uint48 validUntil;

        uint256 limitAmount;
        uint256 limitUsed;

        uint48 lastUsed;
        uint48 refreshInterval;
    }



    event SessionKeyAdded(address indexed sessionKey, address indexed account);


    /**
     * @notice An error indicating that the entry point used when deploying a new module instance is invalid.
     */
    error InvalidEntryPoint();

    /**
     * @notice An error indicating that the caller does not match the Safe in the corresponding user operation.
     * @dev This indicates that the module is being used to validate a user operation for a Safe that did not directly
     * call this module.
     */
    error InvalidCaller();

    /**
     * @notice An error indicating that the call validating or executing a user operation was not called by the
     * supported entry point contract.
     */
    error UnsupportedEntryPoint();

    /**
     * @notice An error indicating that the user operation `callData` does not correspond to one of the two supported
     * execution functions: `executeUserOp` or `executeUserOpWithErrorString`.
     */
    error UnsupportedExecutionFunction(bytes4 selector);

    /**
     * @notice An error indicating that the user operation failed to execute successfully.
     * @dev The contract reverts with this error when `executeUserOp` is used instead of bubbling up the original revert
     * data. When bubbling up revert data is desirable, `executeUserOpWithErrorString` should be used instead.
     */
    error ExecutionFailed();

    error InvalidSessionKey(address sessionKey);
    error InvalidSignature(address sessionKey);

    /**
     * @notice The address of the EntryPoint contract supported by this module.
     */
    address public immutable SUPPORTED_ENTRYPOINT;

    constructor(address entryPoint) {
        if (entryPoint == address(0)) {
            revert InvalidEntryPoint();
        }

        SUPPORTED_ENTRYPOINT = entryPoint;
    }

    /**
     * @notice Validates the call is initiated by the entry point.
     */
    modifier onlySupportedEntryPoint() {
        if (_msgSender() != SUPPORTED_ENTRYPOINT) {
            revert UnsupportedEntryPoint();
        }
        _;
    }

    /**
     * @notice Validates a user operation provided by the entry point.
     * @inheritdoc IAccount
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlySupportedEntryPoint returns (uint256 validationData) {
        address payable safeAddress = payable(userOp.sender);
        // The entry point address is appended to the calldata by the Safe in the `FallbackManager` contract,
        // following ERC-2771. Because of this, the relayer may manipulate the entry point address, therefore
        // we have to verify that the sender is the Safe specified in the userOperation.
        if (safeAddress != msg.sender) {
            revert InvalidCaller();
        }

        // We check the execution function signature to make sure the entry point can't call any other function
        // and make sure the execution of the user operation is handled by the module
        bytes4 selector = bytes4(userOp.callData);
        if (selector != this.executeUserOp.selector && selector != this.executeUserOpWithErrorString.selector && selector != this.executeWithSessionKey.selector) {
            revert UnsupportedExecutionFunction(selector);
        }

        // The userOp nonce is validated in the entry point (for 0.6.0+), therefore we will not check it again
        if (selector == this.executeUserOp.selector) {
             validationData = _validateSignatures(userOp);

        } 

             if (selector == this.executeWithSessionKey.selector) {
             validationData = _validateSessionKeySignature(userOp, userOpHash);

        } 
        

        // We trust the entry point to set the correct prefund value, based on the operation params
        // We need to perform this even if the signature is not valid, else the simulation function of the entry point will not work.
        if (missingAccountFunds != 0) {
            // We intentionally ignore errors in paying the missing account funds, as the entry point is responsible for
            // verifying the prefund has been paid. This behaviour matches the reference base account implementation.
            ISafe(safeAddress).execTransactionFromModule(SUPPORTED_ENTRYPOINT, missingAccountFunds, "", 0);
        }
    }

    /**
     * @notice Executes a user operation provided by the entry point.
     * @param to Destination address of the user operation.
     * @param value Ether value of the user operation.
     * @param data Data payload of the user operation.
     * @param operation Operation type of the user operation.
     */
    function executeUserOp(address to, uint256 value, bytes memory data, uint8 operation) external onlySupportedEntryPoint {
        if (!ISafe(msg.sender).execTransactionFromModule(to, value, data, operation)) {
            revert ExecutionFailed();
        }
    }


    function executeWithSessionKey(Call calldata call, address sessionKey)
        external
        returns (bytes[] memory)
    {
            address token = call.value == 0 ? call.target : address(0);
            uint256 value = call.value == 0 ? _getTokenSpendAmount(call.data) : call.value;


            if(!updateSpendLimitUsage(value, sessionKey, token))  {
            revert ExecutionFailed();
            }

            SessionData memory sessionData = sessionKeys[sessionKey][token];


            if (!ISafe(sessionData.account).execTransactionFromModule(call.target, call.value, call.data, 0)) {
            revert ExecutionFailed();
        }


    }


    function addSessionKey(address sessionKey, address token, SessionData calldata sessionData) public  {

        sessionKeys[sessionKey][token] =  sessionData; 
        sessionKeys[sessionKey][token].account =  msg.sender; 
        emit SessionKeyAdded(sessionKey, msg.sender);

    }

    /**
     * @notice Executes a user operation provided by the entry point and returns error message on failure.
     * @param to Destination address of the user operation.
     * @param value Ether value of the user operation.
     * @param data Data payload of the user operation.
     * @param operation Operation type of the user operation.
     */
    function executeUserOpWithErrorString(address to, uint256 value, bytes memory data, uint8 operation) external onlySupportedEntryPoint {
        (bool success, bytes memory returnData) = ISafe(msg.sender).execTransactionFromModuleReturnData(to, value, data, operation);
        if (!success) {
            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                revert(add(returnData, 0x20), mload(returnData))
            }
        }
    }


    function updateSpendLimitUsage(
        uint256 newUsage,
        address sessionKey,
        address token
    ) internal returns (bool) {


            SessionData storage sessionData = sessionKeys[sessionKey][token];
            

            uint48 refreshInterval =  sessionData.refreshInterval;
            uint48 lastUsed = sessionData.lastUsed;
            uint256 spendLimit = sessionData.limitAmount;
            uint256 currentUsage = sessionData.limitUsed;

        
        if(block.timestamp < sessionData.validAfter || block.timestamp > sessionData.validUntil) {
            return false;
        }


        if (refreshInterval == 0 || lastUsed + refreshInterval > block.timestamp) {
            // We either don't have a refresh interval, or the current one is still active.

            // Must re-check the limits to handle changes due to other user ops.
            // We manually check for overflows here to give a more informative error message.
            uint256 newTotalUsage;
            unchecked {
                newTotalUsage = newUsage + currentUsage;
            }
            if (newTotalUsage < newUsage || newTotalUsage > spendLimit) {
                // If we overflow, or if the limit is exceeded, fail here and revert in the parent context.
                return false;
            }

            // We won't update the refresh interval last used variable now, so just update the spend limit.
            sessionData.limitUsed = newTotalUsage;
        } else {
            // We have a interval active that is currently resetting.
            // Must re-check the amount to handle changes due to other user ops.
            // It only needs to fit within the new refresh interval, since the old one has passed.
            if (newUsage > spendLimit) {
                return false;
            }

            // The refresh interval has passed, so we can reset the spend limit to the new usage.
            sessionData.limitUsed = newUsage;
            sessionData.lastUsed = uint48(block.timestamp);
        }

        return true;
    }

    function _getTokenSpendAmount(bytes memory callData) internal pure returns (uint256) {

        // Expected length: 68 bytes (4 selector + 32 address + 32 amount)
        if (callData.length < 68) {
            return 0;
        }

        // Load the amount being sent/approved.
        // Solidity doesn't support access a whole word from a bytes memory at once, only a single byte, and
        // trying to use abi.decode would require copying the data to remove the selector, which is expensive.
        // Instead, we use inline assembly to load the amount directly. This is safe because we've checked the
        // length of the call data.
        uint256 amount;
        assembly ("memory-safe") {
            // Jump 68 words forward: 32 for the length field, 4 for the selector, and 32 for the to address.
            amount := mload(add(callData, 68))
        }
        return amount;
        
        // Unrecognized function selector
        return 0;
    }

    /**
     * @notice Computes the 32-byte domain separator used in EIP-712 signature verification for Safe operations.
     * @return domainSeparatorHash The EIP-712 domain separator hash for this contract.
     */
    function domainSeparator() public view returns (bytes32 domainSeparatorHash) {
        domainSeparatorHash = keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, block.chainid, this));
    }

    /**
     * @notice Returns the 32-byte Safe operation hash to be signed by owners for the specified ERC-4337 user operation.
     * @dev The Safe operation timestamps are pre-pended to the signature bytes as `abi.encodePacked(validAfter, validUntil, signatures)`.
     * @param userOp The ERC-4337 user operation.
     * @return operationHash Operation hash.
     */
    function getOperationHash(PackedUserOperation calldata userOp) external view returns (bytes32 operationHash) {
        (bytes memory operationData, , , ) = _getSafeOp(userOp);
        operationHash = keccak256(operationData);
    }

    /**
     * @dev Validates that the user operation is correctly signed and returns an ERC-4337 packed validation data
     * of `validAfter || validUntil || authorizer`:
     *  - `authorizer`: 20-byte address, 0 for valid signature or 1 to mark signature failure (this module does not make use of signature aggregators).
     *  - `validUntil`: 6-byte timestamp value, or zero for "infinite". The user operation is valid only up to this time.
     *  - `validAfter`: 6-byte timestamp. The user operation is valid only after this time.
     * @param userOp User operation struct.
     * @return validationData An integer indicating the result of the validation.
     */
    function _validateSignatures(PackedUserOperation calldata userOp) internal view returns (uint256 validationData) {
        (bytes memory operationData, uint48 validAfter, uint48 validUntil, bytes calldata signatures) = _getSafeOp(userOp);
        try ISafe(payable(userOp.sender)).checkSignatures(keccak256(operationData), operationData, signatures) {
            // The timestamps are validated by the entry point, therefore we will not check them again
            validationData = _packValidationData(false, validUntil, validAfter);
        } catch {
            validationData = _packValidationData(true, validUntil, validAfter);
        }
    }


        
    function _validateSessionKeySignature(PackedUserOperation calldata userOp, bytes32 userOpHash) internal view returns (uint256 validationData) {
        (bytes memory operationData, uint48 validAfter, uint48 validUntil, bytes calldata signatures) = _getSafeOp(userOp);

  
             (Call memory call, address sessionKey) = abi.decode(userOp.callData[4:], (Call, address));   

            (address recoveredSig, ECDSA.RecoverError err) = ECDSA.tryRecover(ECDSA.toEthSignedMessageHash(userOpHash), userOp.signature);

            if (err != ECDSA.RecoverError.NoError) {
                validationData = uint256(1);
            }
           
            if (sessionKey != recoveredSig) {
                validationData = uint256(1);
            }
    }

    /**
     * @dev Decodes an ERC-4337 user operation into a Safe operation.
     * @param userOp The ERC-4337 user operation.
     * @return operationData Encoded EIP-712 Safe operation data bytes used for signature verification.
     * @return validAfter The timestamp the user operation is valid from.
     * @return validUntil The timestamp the user operation is valid until.
     * @return signatures The Safe owner signatures extracted from the user operation.
     */
    function _getSafeOp(
        PackedUserOperation calldata userOp
    ) internal view returns (bytes memory operationData, uint48 validAfter, uint48 validUntil, bytes calldata signatures) {
        // Extract additional Safe operation fields from the user operation signature which is encoded as:
        // `abi.encodePacked(validAfter, validUntil, signatures)`
        {
            bytes calldata sig = userOp.signature;
            validAfter = uint48(bytes6(sig[0:6]));
            validUntil = uint48(bytes6(sig[6:12]));
            signatures = sig[12:];
        }

        // It is important that **all** user operation fields are represented in the `SafeOp` data somehow, to prevent
        // user operations from being submitted that do not fully respect the user preferences. The only exception is
        // the `signature` bytes. Note that even `initCode` needs to be represented in the operation data, otherwise
        // it can be replaced with a more expensive initialization that would charge the user additional fees.
        {
            // In order to work around Solidity "stack too deep" errors related to too many stack variables, manually
            // encode the `SafeOp` fields into a memory `struct` for computing the EIP-712 struct-hash. This works
            // because the `EncodedSafeOpStruct` struct has no "dynamic" fields so its memory layout is identical to the
            // result of `abi.encode`-ing the individual fields.
            EncodedSafeOpStruct memory encodedSafeOp = EncodedSafeOpStruct({
                typeHash: SAFE_OP_TYPEHASH,
                safe: userOp.sender,
                nonce: userOp.nonce,
                initCodeHash: keccak256(userOp.initCode),
                callDataHash: keccak256(userOp.callData),
                verificationGasLimit: uint128(userOp.unpackVerificationGasLimit()),
                callGasLimit: uint128(userOp.unpackCallGasLimit()),
                preVerificationGas: userOp.preVerificationGas,
                maxPriorityFeePerGas: uint128(userOp.unpackMaxPriorityFeePerGas()),
                maxFeePerGas: uint128(userOp.unpackMaxFeePerGas()),
                paymasterAndDataHash: keccak256(userOp.paymasterAndData),
                validAfter: validAfter,
                validUntil: validUntil,
                entryPoint: SUPPORTED_ENTRYPOINT
            });

            bytes32 safeOpStructHash;
            // solhint-disable-next-line no-inline-assembly
            assembly ("memory-safe") {
                // Since the `encodedSafeOp` value's memory layout is identical to the result of `abi.encode`-ing the
                // individual `SafeOp` fields, we can pass it directly to `keccak256`. Additionally, there are 14
                // 32-byte fields to hash, for a length of `14 * 32 = 448` bytes.
                safeOpStructHash := keccak256(encodedSafeOp, 448)
            }

            operationData = abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(), safeOpStructHash);
        }
    }
}
