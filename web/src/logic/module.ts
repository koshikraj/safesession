import { Contract, ZeroAddress, parseEther, parseUnits, getBytes, JsonRpcProvider } from "ethers";
import { ethers } from 'ethersv5';
import { BaseTransaction } from '@safe-global/safe-apps-sdk';
import { getSafeInfo, isConnectedToSafe, submitTxs } from "./safeapp";
import { isModuleEnabled, buildEnableModule, isGuardEnabled, buildEnableGuard, buildUpdateFallbackHandler } from "./safe";
import { getJsonRpcProvider, getProvider } from "./web3";
import SafeSessionModule from "./SafeSessionModule.json"
import EntryPoint from "./EntryPoint.json"
import { createSafeAccount, sendTransaction } from "./permissionless";
import { getTokenDecimals, publicClient } from "./utils";
import { buildSessionKeyUserOpTransaction } from "@/utils/userOp";
import { createClient, http, Chain, Hex } from "viem";
import { sepolia } from 'viem/chains'
import { bundlerActions, ENTRYPOINT_ADDRESS_V07, createBundlerClient, getPackedUserOperation, UserOperation, getAccountNonce } from 'permissionless'
import { PackedUserOperation } from "permissionless/types/userOperation";
import { createPimlicoBundlerClient, createPimlicoPaymasterClient } from "permissionless/clients/pimlico";
import { pimlicoBundlerActions, pimlicoPaymasterActions } from 'permissionless/actions/pimlico'
import { loadSessionKey, storeSessionKey } from "@/utils/storage";

const moduleAddress = "0xD144Ae2BafE6DDaEc2143BF769732fb5e8Dfc552"


export const getSessionData = async (chainId: string, sessionKey: string, token: string): Promise<any> => {


    const bProvider = await getJsonRpcProvider(chainId)

    const safeSession = new Contract(
        moduleAddress,
        SafeSessionModule.abi,
        bProvider
    )


    const sesionData = await safeSession.sessionKeys(sessionKey, token);

    return sesionData;

}


function generateRandomString(length: number) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * characters.length);
        result += characters.charAt(randomIndex);
    }
    return result;
}


/**
 * Generates a deterministic key pair from an arbitrary length string
 *
 * @param {string} string - The string to generate a key pair from
 * @returns {Object} - An object containing the address and privateKey
 */
export function generateKeysFromString(string: string) {
    const privateKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(string)) // v5
    const wallet = new ethers.Wallet(privateKey)
    return {
        address: wallet.address,
        privateKey: privateKey,
    }
}




/**
 * Hashes a plain address, adds an Ethereum message prefix, hashes it again and then signs it
 */
export async function signAddress(string: string, privateKey: string) {
    const stringHash = ethers.utils.solidityKeccak256(['address'], [string]) // v5
    const stringHashbinary = ethers.utils.arrayify(stringHash) // v5
    const signer = new ethers.Wallet(privateKey)
    const signature = await signer.signMessage(stringHashbinary) // this calls ethers.hashMessage and prefixes the hash
    return signature
}



export const subscribeWithSessionKey = async (recipient: string, amount: bigint): Promise<string> => {

    const info = await getSafeInfo()
    const provider = await getProvider()
    // Updating the provider RPC if it's from the Safe App.
    const chainId = (await provider.getNetwork()).chainId.toString()
    const bProvider = await getJsonRpcProvider(chainId)

    const sessionKey = loadSessionKey()

    var sessionAccount = new ethers.Wallet(sessionKey.privateKey)

    const { limitAmount } = await getSessionData(chainId, sessionAccount.address, ZeroAddress)


    const call = {target: recipient, value: amount, data: '0x'}


    const nonce = await getAccountNonce(publicClient(parseInt(chainId)), {
        sender: info.safeAddress as Hex,
        entryPoint: ENTRYPOINT_ADDRESS_V07
    })


    let sessionOp = buildSessionKeyUserOpTransaction(
        info.safeAddress,
        call,
        nonce,
        sessionAccount.address,
      )

    const entryPoint = new Contract(
        ENTRYPOINT_ADDRESS_V07,
        EntryPoint.abi,
        bProvider
    )


    const chain = "sepolia" 


    const pimlicoEndpoint = `https://api.pimlico.io/v2/${chain}/rpc?apikey=${import.meta.env.VITE_PIMLICO_API_KEY}`


    const bundlerClient = createClient({
        transport: http(pimlicoEndpoint),
        chain: sepolia as Chain,
    })
        .extend(bundlerActions(ENTRYPOINT_ADDRESS_V07))
        .extend(pimlicoBundlerActions(ENTRYPOINT_ADDRESS_V07))

     const paymasterClient = createPimlicoPaymasterClient({
        transport: http(pimlicoEndpoint),
        entryPoint: ENTRYPOINT_ADDRESS_V07,
    })
    
     


    const gasPrice = await bundlerClient.getUserOperationGasPrice()


    sessionOp.maxFeePerGas = gasPrice.fast.maxFeePerGas;
    sessionOp.maxPriorityFeePerGas = gasPrice.fast.maxPriorityFeePerGas;



    const sponsorUserOperationResult = await paymasterClient.sponsorUserOperation({
        userOperation: sessionOp,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
    })



   
    const sponsoredUserOperation: UserOperation<"v0.7"> = {
        ...sessionOp,
        ...sponsorUserOperationResult,
    }


    let typedDataHash = getBytes(await entryPoint.getUserOpHash(getPackedUserOperation(sponsoredUserOperation)))

 
    sponsoredUserOperation.signature = await sessionAccount.signMessage(typedDataHash) as `0x${string}`

    console.log(sponsoredUserOperation)

    const userOperationHash = await bundlerClient.sendUserOperation({
        userOperation: sponsoredUserOperation,

    })

    return userOperationHash;

}


export const waitForExecution = async (userOperationHash: string) => {


    const chain = "sepolia" 


    const pimlicoEndpoint = `https://api.pimlico.io/v2/${chain}/rpc?apikey=${import.meta.env.VITE_PIMLICO_API_KEY}`


    const bundlerClient = createClient({
        transport: http(pimlicoEndpoint),
        chain: sepolia as Chain,
    })
        .extend(bundlerActions(ENTRYPOINT_ADDRESS_V07))
        .extend(pimlicoBundlerActions(ENTRYPOINT_ADDRESS_V07))

     const paymasterClient = createPimlicoPaymasterClient({
        transport: http(pimlicoEndpoint),
        entryPoint: ENTRYPOINT_ADDRESS_V07,
    })
    

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOperationHash })

    return receipt;

}




const buildAddSessionKey = async (sessionKey: string, token: string, amount: string, refreshInterval: number, validAfter: number, validUntil: number ): Promise<BaseTransaction> => {

    
    const info = await getSafeInfo()

    const sessionData = {account: info.safeAddress, validAfter: validAfter, validUntil: validUntil, limitAmount: parseEther(amount), limitUsed: 0, lastUsed: 0, refreshInterval: refreshInterval }

    const provider = await getProvider()
    // Updating the provider RPC if it's from the Safe App.
    const chainId = (await provider.getNetwork()).chainId.toString()
    const bProvider = await getJsonRpcProvider(chainId)

    const safeSession = new Contract(
        moduleAddress,
        SafeSessionModule.abi,
        bProvider
    )

    return {
        to: moduleAddress,
        value: "0",
        data: (await safeSession.addSessionKey.populateTransaction(sessionKey, token, sessionData)).data
    }
}



export const createSessionKey = async (token: string, amount: string, refreshInterval: number, validAfter: number, validUntil: number ): Promise<{address: string, privateKey: string}> => {

    
    if (!await isConnectedToSafe()) throw Error("Not connected to a Safe")

    const info = await getSafeInfo()

    const txs: BaseTransaction[] = []

    const randomSeed = generateRandomString(18)

    const { address, privateKey } = generateKeysFromString(randomSeed);


    storeSessionKey(address, privateKey);



    if (!await isModuleEnabled(info.safeAddress, moduleAddress)) {
        txs.push(await buildEnableModule(info.safeAddress, moduleAddress))
        txs.push(await buildUpdateFallbackHandler(info.safeAddress, moduleAddress))
    }

    txs.push(await buildAddSessionKey(address, token, amount, refreshInterval, validAfter, validUntil))

    const provider = await getProvider()
    // Updating the provider RPC if it's from the Safe App.
    const chainId = (await provider.getNetwork()).chainId.toString()

    if (txs.length == 0) return {address: '', privateKey: ''}
    await submitTxs(txs)

    return { address, privateKey }
}







