import bs58 from "bs58";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  sendAndConfirmRawTransaction
} from "@solana/web3.js";

export default class Level5SolanaSigner {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    this.connection = options.connection || new Connection(this.rpcUrl, {
      commitment: options.commitment || "confirmed"
    });

    this.secretKeyBase58 =
      options.secretKeyBase58 ||
      process.env.SOLANA_PRIVATE_KEY_BASE58 ||
      "";

    if (!this.secretKeyBase58) {
      throw new Error("Missing SOLANA_PRIVATE_KEY_BASE58");
    }

    this.owner = this.#loadKeypair(this.secretKeyBase58);
  }

  #loadKeypair(secretKeyBase58) {
    const secret = bs58.decode(secretKeyBase58);
    return Keypair.fromSecretKey(secret);
  }

  getPublicKeyBase58() {
    return this.owner.publicKey.toBase58();
  }

  decodeVersionedTransaction(base64Tx) {
    const bytes = Buffer.from(base64Tx, "base64");
    return VersionedTransaction.deserialize(bytes);
  }

  signVersionedTransaction(base64Tx) {
    const tx = this.decodeVersionedTransaction(base64Tx);
    tx.sign([this.owner]);
    return tx;
  }

  serializeSignedTransaction(tx) {
    return Buffer.from(tx.serialize());
  }

  async sendSignedTransaction(tx, options = {}) {
    const raw = this.serializeSignedTransaction(tx);

    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: options.skipPreflight ?? false,
      maxRetries: options.maxRetries ?? 3
    });

    if (options.confirm !== false) {
      const latestBlockhash = await this.connection.getLatestBlockhash("confirmed");
      await this.connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
        },
        "confirmed"
      );
    }

    return signature;
  }

  async sendSignedTransactionLegacy(tx, options = {}) {
    const raw = this.serializeSignedTransaction(tx);
    return sendAndConfirmRawTransaction(this.connection, raw, {
      commitment: "confirmed"
    });
  }
}
