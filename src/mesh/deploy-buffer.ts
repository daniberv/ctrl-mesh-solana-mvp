import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Loader-v3 Write layout follows solana-loader-v3-interface's bincode instruction. */
export async function uploadProgramBuffer(
  connection: Connection,
  buffer: Keypair,
  authority: Keypair,
  artifact: Buffer
) {
  let account = await connection.getAccountInfo(buffer.publicKey, "confirmed");
  if (!account) {
    const lamports = await connection.getMinimumBalanceForRentExemption(
      37 + artifact.length
    );
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: buffer.publicKey,
          space: 37 + artifact.length,
          lamports,
          programId: LOADER,
        }),
        new TransactionInstruction({
          programId: LOADER,
          keys: [
            { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: false, isWritable: false },
          ],
          data: Buffer.alloc(4),
        })
      ),
      [authority, buffer],
      { commitment: "confirmed" }
    );
    account = await connection.getAccountInfo(buffer.publicKey, "confirmed");
  }
  if (
    !account ||
    !account.owner.equals(LOADER) ||
    account.data.length !== 37 + artifact.length ||
    account.data.readUInt32LE(0) !== 1 ||
    account.data[4] !== 1 ||
    !new PublicKey(account.data.subarray(5, 37)).equals(authority.publicKey)
  )
    throw Error("Deployment buffer size, loader or authority mismatch");
  const offsets: number[] = [];
  for (let offset = 0; offset < artifact.length; offset += 900) {
    const bytes = artifact.subarray(
      offset,
      Math.min(artifact.length, offset + 900)
    );
    if (
      !account.data
        .subarray(37 + offset, 37 + offset + bytes.length)
        .equals(bytes)
    )
      offsets.push(offset);
  }
  console.log(
    `Devnet buffer: ${offsets.length} chunks remain; uploading in confirmed batches of 16.`
  );
  for (let first = 0; first < offsets.length; first += 16) {
    const block = await connection.getLatestBlockhash("confirmed");
    const signatures = await Promise.all(
      offsets.slice(first, first + 16).map(async (offset) => {
        const bytes = artifact.subarray(
          offset,
          Math.min(artifact.length, offset + 900)
        );
        const data = Buffer.alloc(16 + bytes.length);
        data.writeUInt32LE(1, 0);
        data.writeUInt32LE(offset, 4);
        data.writeBigUInt64LE(BigInt(bytes.length), 8);
        bytes.copy(data, 16);
        const tx = new Transaction({
          feePayer: authority.publicKey,
          ...block,
        }).add(
          new TransactionInstruction({
            programId: LOADER,
            keys: [
              { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
              {
                pubkey: authority.publicKey,
                isSigner: true,
                isWritable: false,
              },
            ],
            data,
          })
        );
        tx.sign(authority);
        return connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
      })
    );
    const end = Date.now() + 45000;
    for (;;) {
      const statuses = (await connection.getSignatureStatuses(signatures))
        .value;
      if (statuses.some((s) => s?.err))
        throw Error(
          "Program buffer write failed; rerun to resume the saved buffer"
        );
      if (
        statuses.every(
          (s) =>
            s && ["confirmed", "finalized"].includes(s.confirmationStatus || "")
        )
      )
        break;
      if (Date.now() > end)
        throw Error("Program buffer confirmation timed out; rerun to resume");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(
      `Devnet buffer confirmed: ${Math.min(offsets.length, first + 16)} / ${
        offsets.length
      } missing chunks written.`
    );
  }
  const written = await connection.getAccountInfo(
    buffer.publicKey,
    "confirmed"
  );
  if (!written?.data.subarray(37).equals(artifact))
    throw Error("Uploaded program buffer differs from the local binary");
  console.log(
    "Devnet upload verified byte for byte; finalizing with the Solana CLI."
  );
}
