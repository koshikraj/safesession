import { expect } from 'chai'
import { deployments, ethers } from 'hardhat'
import { getTestSafe, getSafeSessionModule, getEntryPoint, getTestToken } from '../utils/setup'
import { buildSignatureBytes, signHash, logGas } from '../../src/utils/execution'
import {
  buildPackedUserOperationFromSafeUserOperation,
  buildSafeUserOpTransaction,
  buildSessionKeyUserOpTransaction,
} from '../../src/utils/userOp'
import { chainId } from '../utils/encoding'
import execSafeTransaction from '../utils/execSafeTransaction';
import { ZeroAddress } from 'ethers';

export function delay(timeout = 10000) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

describe('SafeSessionModule - Existing Safe', () => {
  const setupTests = deployments.createFixture(async ({ deployments }) => {
    await deployments.fixture()

    // var privateKey = ethers.Wallet.createRandom().privateKey
    // var user1 = new ethers.Wallet(privateKey)

    const [user1, user2, relayer] = await ethers.getSigners()
    let entryPoint = await getEntryPoint()
    entryPoint = entryPoint.connect(relayer)
    const module = await getSafeSessionModule()
    const testToken = await getTestToken()
    const safe = await getTestSafe(user1, await module.getAddress(), await module.getAddress())

    return {
      testToken,
      user1,
      user2,
      safe,
      relayer,
      validator: module,
      entryPoint,
    }
  })

  describe('handleOps - existing account', () => {
    it('should revert with invalid signature', async () => {
      const { user1, safe, entryPoint } = await setupTests()

      await user1.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther('1.0') })
      const safeOp = buildSafeUserOpTransaction(
        await safe.getAddress(),
        user1.address,
        ethers.parseEther('0.5'),
        '0x',
        '0',
        await entryPoint.getAddress(),
      )
      const signature = buildSignatureBytes([await signHash(user1, ethers.keccak256('0xbaddad42'))])
      const userOp = buildPackedUserOperationFromSafeUserOperation({ safeOp, signature })
      await expect(entryPoint.handleOps([userOp], user1.address))
        .to.be.revertedWithCustomError(entryPoint, 'FailedOp')
        .withArgs(0, 'AA24 signature error')

      expect(await ethers.provider.getBalance(await safe.getAddress())).to.be.eq(ethers.parseEther('1.0'))
    })

    it('should execute multiple session key transaction within limit and time interval', async () => {
      const { user1, safe, validator, entryPoint, relayer } = await setupTests()

      await entryPoint.depositTo(await safe.getAddress(), { value: ethers.parseEther('1.0') })

      await user1.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther('1') })

      const call = {target: user1.address, value: ethers.parseEther('0.5'), data: '0x'}

      const currentTime = Math.floor(Date.now()/1000)

      const sessionData = {account: await safe.getAddress(), validAfter: currentTime, validUntil: currentTime + 20, limitAmount: ethers.parseEther('1'), limitUsed: 0, lastUsed: 0, refreshInterval: 0 }

      await execSafeTransaction(safe, await validator.addSessionKey.populateTransaction(user1.address, ZeroAddress, sessionData))

      let sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '0',
        user1.address,
      )

      let typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)
      await logGas('Execute UserOp without a prefund payment', entryPoint.handleOps([sessionOp], relayer))

       sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '1',
        user1.address,
      )

       typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)

      await logGas('Execute UserOp without a prefund payment', entryPoint.handleOps([sessionOp], relayer))
      expect(await ethers.provider.getBalance(await safe.getAddress())).to.be.eq(ethers.parseEther('0'))
    })


    it('should execute multiple session key transaction within limit and after refresh interval', async () => {
      const { user1, safe, validator, entryPoint, relayer } = await setupTests()

      await entryPoint.depositTo(await safe.getAddress(), { value: ethers.parseEther('1.0') })

      await user1.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther('1') })

      const call = {target: user1.address, value: ethers.parseEther('0.5'), data: '0x'}

      const currentTime = Math.floor(Date.now()/1000)

      const sessionData = {account: await safe.getAddress(), validAfter: currentTime, validUntil: currentTime + 30, limitAmount: ethers.parseEther('0.5'), limitUsed: 0, lastUsed: 0, refreshInterval: 5 }

      await execSafeTransaction(safe, await validator.addSessionKey.populateTransaction(user1.address, ZeroAddress, sessionData))

      let sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '0',
        user1.address,
      )

      let typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)
      await logGas('Execute UserOp before the refresh interval', entryPoint.handleOps([sessionOp], relayer))


      // Wait for 10 seconds for the next subscription interval
      await delay(5000);

       sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '1',
        user1.address,
      )

       typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)

      await logGas('Execute UserOp after the refresh interval', entryPoint.handleOps([sessionOp], relayer))
      expect(await ethers.provider.getBalance(await safe.getAddress())).to.be.eq(ethers.parseEther('0'))
    })


    it('should execute multiple session key transaction within limit and after refresh interval with erc20 token', async () => {
      const { testToken, user1, safe, validator, entryPoint, relayer } = await setupTests()

      await entryPoint.depositTo(await safe.getAddress(), { value: ethers.parseEther('1.0') })

      await testToken.transfer(safe.getAddress(), ethers.parseEther('10'))

      // await user1.sendTransaction({ to: await safe.getAddress(), value: ethers.parseEther('1') })
      

      const abi = [
        'function transfer(address to, uint256 amount) external',
      ]
    
      const callData = new ethers.Interface(abi).encodeFunctionData('transfer', [user1.address, ethers.parseEther('5')])
    

      const call = {target: await testToken.getAddress(), value: 0, data: callData}

      const currentTime = Math.floor(Date.now()/1000)

      const sessionData = {account: await safe.getAddress(), validAfter: currentTime, validUntil: currentTime + 30, limitAmount: ethers.parseEther('5'), limitUsed: 0, lastUsed: 0, refreshInterval: 5 }

      await execSafeTransaction(safe, await validator.addSessionKey.populateTransaction(user1.address, await testToken.getAddress(), sessionData))

      let sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '0',
        user1.address,
      )

      let typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)

      await logGas('Execute UserOp before the refresh interval', entryPoint.handleOps([sessionOp], relayer))


 
      // Wait for 10 seconds for the next subscription interval
      await delay(5000);

       sessionOp = buildSessionKeyUserOpTransaction(
        await safe.getAddress(),
        call,
        '1',
        user1.address,
      )

       typedDataHash = ethers.getBytes(await entryPoint.getUserOpHash(sessionOp))
      sessionOp.signature = await user1.signMessage(typedDataHash)

      await logGas('Execute UserOp after the refresh interval', entryPoint.handleOps([sessionOp], relayer))
      expect(await await testToken.balanceOf(await safe.getAddress())).to.be.eq(ethers.parseEther('0'))
    })


  })
})
