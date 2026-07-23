import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
const client = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
let token;
const keys = [];
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, ContinuationToken: token }));
  keys.push(...(page.Contents || []).map((item) => ({ key: item.Key, size: item.Size })));
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);
console.log(JSON.stringify(keys, null, 2));
