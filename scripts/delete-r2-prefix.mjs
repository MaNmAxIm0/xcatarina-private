import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
const prefix = process.argv[2];
if (!prefix || prefix.includes("..") || !prefix.startsWith("videos/")) throw new Error("Indica um prefixo videos/ explícito.");
const client = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
let token;
const keys = [];
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix, ContinuationToken: token }));
  keys.push(...(page.Contents || []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []));
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
if (keys.length) await client.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys, Quiet: true } }));
console.log(`Removidos ${keys.length} objetos do prefixo ${prefix}.`);
