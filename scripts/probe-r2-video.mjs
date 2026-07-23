import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const file = process.argv[2];
if (!file) throw new Error("Indica o caminho de um MP4.");
const client = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const info = await stat(file);
const key = `healthcheck/video-${randomUUID()}.mp4`;
try {
  await new Upload({ client, params: { Bucket: process.env.R2_BUCKET, Key: key, Body: createReadStream(file), ContentLength: info.size, ContentType: "video/mp4" }, partSize: 8 * 1024 * 1024, queueSize: 2 }).done();
  console.log(JSON.stringify({ ok: true, bytes: info.size }));
} catch (error) {
  console.error(JSON.stringify({ name: error.name, message: error.message, status: error.$metadata?.httpStatusCode, rawStatus: error.$response?.statusCode }));
  process.exitCode = 1;
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })).catch(() => undefined);
}
