const initServer = (sdk, network) => {
  let horizonUrl
  if (network === 'public') {
    sdk.Network.usePublicNetwork()
    horizonUrl = 'https://horizon.stellar.org'
  } else {
    sdk.Network.useTestNetwork()
    horizonUrl = 'https://horizon-testnet.stellar.org'
  }
  return new sdk.Server(horizonUrl, {allowHttp: false})
}

const matchSigner = (signer, type, key, weight) =>
  signer.type === type && signer.key === key && signer.weight === weight

const matchOne = (array, matcherFn) => array.filter(matcherFn) === 1

const validHoldingAccountSignerSetup = (
  accAddress,
  signers,
  hashX,
  withdrawer
) =>
  signers.length === 3 &&
  matchOne(signers, s => matchSigner(s, 'sha256_hash', hashX, 1)) &&
  matchOne(signers, s => matchSigner(s, 'ed25519_public_key', withdrawer, 1)) &&
  matchOne(signers, s => matchSigner(s, 'ed25519_public_key', accAddress, 0))

/**
 * Interface to the Stellar network providing implementations of required xcat
 * transactions as well as routines to check the state of the ledger.
 */

class Stellar {
  constructor(sdk, network) {
    this.sdk = sdk
    this.server = initServer(sdk, network)
  }

  async createHoldingAccount(
    newAccKeypair,
    sellerKeypair,
    buyerPublicAddr,
    hashX
  ) {
    const sellerAccount = await this.server.loadAccount(
      sellerKeypair.publicKey()
    )
    const tx = this.createHoldingAccountTx(
      newAccKeypair,
      sellerAccount,
      buyerPublicAddr,
      hashX
    )
    tx.sign(newAccKeypair, sellerKeypair)
    return this.server.submitTransaction(tx)
  }

  createHoldingAccountTx(newAccKeypair, sellerAccount, buyerPublicAddr, hashX) {
    const tb = new this.sdk.TransactionBuilder(sellerAccount)

    // Op1: Create holding account
    tb.addOperation(
      this.sdk.Operation.createAccount({
        destination: newAccKeypair.publicKey(),
        startingBalance: '40', // +20 base; +10 hash(x) signer; +10 buyer signer
      }) // TODO: don't use 10 .. pull value of base from latest ledger
    )

    // Op2: Add buyer as signer on holding account
    tb.addOperation(
      this.sdk.Operation.setOptions({
        source: newAccKeypair.publicKey(),
        signer: {
          ed25519PublicKey: buyerPublicAddr,
          weight: 1,
        },
      })
    )

    // Op3: Configure signing thresholds and add Hash(x) signer:
    //  - add hash(x) as signer on holding account with weight 1
    //  - set master weight to 0 (so holding account can't sign it's own txs)
    //  - set thresholds for all signing levels to 2 so 2 signatures are required
    tb.addOperation(
      this.sdk.Operation.setOptions({
        source: newAccKeypair.publicKey(),
        signer: {
          sha256Hash: hashX,
          weight: 1,
        },
        masterWeight: 0,
        lowThreshhold: 2,
        medThreshhold: 2,
        highThreshhold: 2,
      })
    )

    return tb.build()
  }

  /**
   * Validates a given holding account exists and is setup correctly.
   *
   * @param holdingAccountAddress Holding account public key
   * @param depositorAddress Address of the depositing account
   * @param withdrawerAddress Address of the withdrawer
   * @param hashX Hash(x) signer hash
   */
  async isValidHoldingAccount(
    holdingAccountAddress,
    depositorAddress,
    withdrawerAddress,
    hashX
  ) {
    const acc = await this.server
      .loadAccount(holdingAccountAddress)
      .catch(this.sdk.NotFoundError, () => undefined)
      .catch(e => {
        console.error(
          `unknown error fetching account ${holdingAccountAddress}`,
          e
        )
        throw e
      })

    if (!acc) return false

    return validHoldingAccountSignerSetup(
      holdingAccountAddress,
      acc.signers,
      hashX,
      withdrawerAddress
    )
  }

  /**
   * Buyer creates and signs a refund tx for the seller for the case the
   * transfer does not complete. The seller can add their signature
   * (or the hash(x) signature depending on the setup) to make the refund tx
   * valid.
   */
  sellerRefundTx(
    holdingAccount,
    buyerKeypair,
    sellerPublicAddr,
    locktime,
    amount
  ) {
    const tb = new this.sdk.TransactionBuilder(holdingAccount, {
      timeBounds: {minTime: locktime},
    })

    tb.addOperation(
      this.sdk.Operation.payment({
        destination: sellerPublicAddr,
        amount: String(amount),
        asset: this.sdk.Asset.native(),
      })
    )

    const tx = tb.build()
    tx.sign(buyerKeypair)
    return tx
  }

  /**
   * Seller deposits funds into the holding account tx..
   */
  sellerDepositTx(sellerAccount, sellerKeypair, holdingAccPublicAddr, amount) {
    const tb = new this.sdk.TransactionBuilder(sellerAccount)

    tb.addOperation(
      this.sdk.Operation.payment({
        destination: holdingAccPublicAddr,
        amount: String(amount),
        asset: this.sdk.Asset.native(),
      })
    )

    const tx = tb.build()
    tx.sign(sellerKeypair)
    return tx
  }

  /**
   * Buyer withdraws funds from the holding account tx revealing preimage (x)
   * by adding x as a signer.
   */
  buyerWithdrawTx(holdingAccount, buyerKeypair, preimage, amount) {
    const tb = new this.sdk.TransactionBuilder(holdingAccount)

    tb.addOperation(
      this.sdk.Operation.payment({
        destination: buyerKeypair.publicKey(),
        amount: String(amount),
        asset: this.sdk.Asset.native(),
      })
    )

    const tx = tb.build()
    tx.sign(buyerKeypair, preimage)
    return tx
  }
}

export default Stellar
