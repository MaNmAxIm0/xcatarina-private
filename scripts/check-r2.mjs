import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"];
for (const name of required) if (!process.env[name]) throw new Error(`Falta ${name}.`);
const client = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const key = `healthcheck/${randomUUID()}.txt`;
let created = false;
try {
  await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: "xcatarina-r2-ok", ContentType: "text/plain" }));
  created = true;
  const publicUrl = `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  const response = await fetch(publicUrl);
  const text = await response.text();
  await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, MaxKeys: 1 }));
  if (!response.ok || text !== "xcatarina-r2-ok") throw new Error(`A escrita funciona, mas o endereço público respondeu com HTTP ${response.status}.`);
  console.log("R2 OK: escrita, leitura pública e listagem confirmadas.");
} finally {
  if (created) await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}
