# S3 Bucket Browser App (React + Express)

A minimal, production-ready UI to browse a single Amazon S3 bucket: list, upload, download, create folders, and delete objects. Uses pre-signed URLs for secure uploads/downloads.

---

## Features
- Browse prefixes like folders (with breadcrumbs)
- Upload via pre-signed PUT URL (progress bar)
- Download via pre-signed GET URL
- Create folders (zero-byte objects with trailing `/`)
- Delete objects and empty "folders"
- Pagination for large buckets (ListObjectsV2 with continuation tokens)
- No AWS keys in the browser; server signs requests with AWS SDK v3
- CORS-safe and S3 ACL-safe (no public exposure required)

---

## Architecture
```
web (React/Vite)  ⟷  server (Node/Express, AWS SDK v3)  ⟷  S3
```

- The server exposes a tiny REST API that signs upload/download requests and proxies list/create/delete.
- The React app never sees AWS credentials; it only calls the server.

---

## IAM Setup (attach to the server’s execution role or IAM user)
Create a policy like this and attach it to whichever credential your server uses (EC2, ECS, Lambda, local dev user):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBucketListAndReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::ti-hackathon-2025"
    },
    {
      "Sid": "AllowObjectRW",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::ti-hackathon-2025/*"
    }
  ]
}
```

> Replace `ti-hackathon-2025` with your bucket.

If your server runs inside AWS (EC2/ECS/Lambda), prefer a role with this policy instead of static keys.

---

## Server (Node + Express)

**/server/package.json**
```json
{
  "name": "s3-browser-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "node server.js",
    "start": "NODE_ENV=production node server.js"
  },
  "dependencies": {
    "aws-sdk": "^2.1637.0",
    "aws4": "^1.13.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "morgan": "^1.10.0"
  }
}
```

> Note: Using AWS SDK v2 here for its simple `getSignedUrl`. You can switch to v3 if you prefer.

**/server/.env.example**
```
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_access_key_id    # if not using an instance/role
AWS_SECRET_ACCESS_KEY=your_secret
S3_BUCKET=ti-hackathon-2025
PORT=4000
CORS_ORIGIN=http://localhost:5173
SIGNED_URL_TTL_SECONDS=900
```

**/server/server.js**
```js
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import AWS from 'aws-sdk';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

const s3 = new AWS.S3({ region: process.env.AWS_REGION });
const Bucket = process.env.S3_BUCKET;
const URL_TTL = parseInt(process.env.SIGNED_URL_TTL_SECONDS || '900', 10);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// List objects in a prefix (folder)
app.get('/api/list', async (req, res) => {
  try {
    const { prefix = '', token } = req.query;
    const params = {
      Bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
      MaxKeys: 1000,
    };
    const data = await s3.listObjectsV2(params).promise();
    res.json({
      prefix,
      commonPrefixes: (data.CommonPrefixes || []).map(p => p.Prefix),
      contents: (data.Contents || []).map(o => ({
        key: o.Key,
        size: o.Size,
        lastModified: o.LastModified,
        isFolder: o.Key.endsWith('/'),
      })),
      nextToken: data.IsTruncated ? data.NextContinuationToken : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Create an empty folder (zero-byte object ending with "/")
app.post('/api/create-folder', async (req, res) => {
  try {
    const { key } = req.body; // e.g. "photos/2025/"
    if (!key || !key.endsWith('/')) {
      return res.status(400).json({ error: 'key must end with "/"' });
    }
    await s3.putObject({ Bucket, Key: key, Body: '' }).promise();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for upload (single-part PUT). Client performs PUT directly to S3.
app.post('/api/presign-upload', async (req, res) => {
  try {
    const { key, contentType } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const url = await s3.getSignedUrlPromise('putObject', {
      Bucket,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
      Expires: URL_TTL,
    });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get presigned URL for download
app.post('/api/presign-download', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const url = await s3.getSignedUrlPromise('getObject', {
      Bucket,
      Key: key,
      Expires: URL_TTL,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(key.split('/').pop())}"`,
    });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete one object (or use prefix deletion client-side by listing then calling this for each)
app.delete('/api/object', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    await s3.deleteObject({ Bucket, Key: key }).promise();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete (up to 1000 per call)
app.post('/api/delete-bulk', async (req, res) => {
  try {
    const { keys = [] } = req.body;
    if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: 'keys is required' });
    const params = {
      Bucket,
      Delete: { Objects: keys.map(k => ({ Key: k })) },
    };
    const data = await s3.deleteObjects(params).promise();
    res.json({ deleted: data.Deleted || [], errors: data.Errors || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server listening on :${port}`));
```

---

## Web (React + Vite)

**/web/package.json**
```json
{
  "name": "s3-browser-web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --port 5173"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "vite": "^5.4.0"
  }
}
```

**/web/index.html**
```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>S3 Browser</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 0; }
      .container { max-width: 1100px; margin: 0 auto; padding: 16px; }
      .toolbar { display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
      .grid { display:grid; grid-template-columns: 1fr 140px 220px 150px; gap: 8px; }
      .row { padding: 8px; border-bottom: 1px solid #eee; align-items:center; display: contents; }
      .row:hover { background: #fafafa; }
      .btn { padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor:pointer; }
      .btn.primary { background: #111; color:#fff; border-color:#111; }
      .pill { padding:2px 8px; border:1px solid #e5e7eb; border-radius:9999px; font-size:12px; display:inline-block; }
      .crumbs { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
      .crumbs button { background:none; border:none; color:#2563eb; cursor:pointer; padding:0; }
      .header { font-weight:600; }
      .progress { height: 8px; background:#e5e7eb; border-radius:9999px; overflow:hidden; }
      .bar { height:100%; width:0%; background:#111; }
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr 100px 160px 120px; } }
      @media (max-width: 640px) { .grid { grid-template-columns: 1fr 90px; } .hide-sm { display:none; } }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.jsx"></script>
  </body>
</html>
```

**/web/main.jsx**
```jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/App.jsx'

createRoot(document.getElementById('root')).render(<App />)
```

**/web/src/api.js**
```js
const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export async function list(prefix = '', token) {
  const url = new URL(BASE + '/api/list');
  if (prefix) url.searchParams.set('prefix', prefix);
  if (token) url.searchParams.set('token', token);
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createFolder(key) {
  const res = await fetch(BASE + '/api/create-folder', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function presignUpload(key, contentType) {
  const res = await fetch(BASE + '/api/presign-upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, contentType })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function presignDownload(key) {
  const res = await fetch(BASE + '/api/presign-download', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteBulk(keys) {
  const res = await fetch(BASE + '/api/delete-bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

**/web/src/App.jsx**
```jsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { list, createFolder, presignUpload, presignDownload, deleteBulk } from './api'

function humanSize(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B','KB','MB','GB','TB']
  const i = Math.floor(Math.log(bytes)/Math.log(1024))
  return `${(bytes/Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export default function App() {
  const [prefix, setPrefix] = useState('')
  const [data, setData] = useState({ commonPrefixes: [], contents: [], nextToken: null })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef()

  async function load(token) {
    setLoading(true)
    setError('')
    try {
      const res = await list(prefix, token)
      setData(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [prefix])

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    const out = []
    let p = ''
    out.push({ name: 'root', p: '' })
    for (const part of parts) {
      p = p + part + '/'
      out.push({ name: part, p })
    }
    return out
  }, [prefix])

  function openFolder(p) { setPrefix(p) }

  async function onCreateFolder() {
    const name = prompt('Folder name')
    if (!name) return
    const key = prefix + name.replaceAll('\\', '/').replaceAll('..', '') + '/'
    await createFolder(key)
    await load()
  }

  function onSelect(key, checked) {
    const next = new Set(selected)
    if (checked) next.add(key); else next.delete(key)
    setSelected(next)
  }

  async function onDelete() {
    if (selected.size === 0) return
    if (!confirm(`Delete ${selected.size} item(s)?`)) return
    // If a "folder" is selected, delete all under it: we fetch pages until done.
    const keys = Array.from(selected)
    const expanded = []
    for (const k of keys) {
      if (k.endsWith('/')) {
        let token
        do {
          const page = await list(k, token)
          const children = page.contents.filter(o => o.key !== k).map(o => o.key)
          expanded.push(...children)
          token = page.nextToken
        } while (token)
        expanded.push(k) // delete the folder marker too
      } else {
        expanded.push(k)
      }
    }
    const chunks = (arr, n) => arr.length ? [arr.slice(0,n), ...chunks(arr.slice(n), n)] : []
    for (const chunk of chunks(expanded, 1000)) {
      await deleteBulk(chunk)
    }
    setSelected(new Set())
    await load()
  }

  async function onDownload(key) {
    const { url } = await presignDownload(key)
    window.location.href = url
  }

  async function onUpload(ev) {
    const file = ev.target.files?.[0]
    if (!file) return
    const key = prefix + file.name
    setUploading(true)
    setProgress(0)
    try {
      const { url } = await presignUpload(key, file.type || 'application/octet-stream')
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', url)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => xhr.status < 400 ? resolve() : reject(new Error('Upload failed'))
        xhr.onerror = () => reject(new Error('Network error'))
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
        xhr.send(file)
      })
      await load()
      alert('Uploaded!')
    } catch (e) {
      alert(e.message)
    } finally {
      setUploading(false)
      setProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="container">
      <h1 style={{ fontSize: 28, margin: '12px 0' }}>S3 Bucket Browser</h1>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={c.p}>
              {i>0 && <span> / </span>}
              <button onClick={() => openFolder(c.p)}>{c.name}</button>
            </span>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onCreateFolder}>New Folder</button>
        <label className="btn primary" style={{ cursor: 'pointer' }}>
          Upload
          <input ref={fileInputRef} type="file" onChange={onUpload} style={{ display: 'none' }} />
        </label>
        <button className="btn" onClick={onDelete} disabled={selected.size === 0}>Delete</button>
      </div>

      {uploading && (
        <div className="progress" style={{ marginBottom: 12 }}>
          <div className="bar" style={{ width: progress + '%' }} />
        </div>
      )}

      {error && <div style={{ color: 'red', marginBottom: 8 }}>{error}</div>}

      <div className="grid header" style={{ padding: '8px 0', borderBottom: '1px solid #eee' }}>
        <div>Name</div>
        <div className="hide-sm">Size</div>
        <div className="hide-sm">Last Modified</div>
        <div>Actions</div>
      </div>

      {loading ? (
        <div style={{ padding: 16 }}>Loading…</div>
      ) : (
        <div>
          {data.commonPrefixes.map(p => (
            <div className="row" key={p}>
              <div>
                <input type="checkbox" onChange={e => onSelect(p, e.target.checked)} />
                <button className="btn" style={{ marginLeft: 8 }} onClick={() => openFolder(p)}>📁 {p.replace(prefix, '')}</button>
              </div>
              <div className="hide-sm">—</div>
              <div className="hide-sm">—</div>
              <div><span className="pill">Folder</span></div>
            </div>
          ))}

          {data.contents.filter(o => o.key !== prefix).map(o => (
            <div className="row" key={o.key}>
              <div>
                <input type="checkbox" onChange={e => onSelect(o.key, e.target.checked)} />
                <span style={{ marginLeft: 8 }}>🗎 {o.key.replace(prefix, '')}</span>
              </div>
              <div className="hide-sm">{humanSize(o.size)}</div>
              <div className="hide-sm">{new Date(o.lastModified).toLocaleString()}</div>
              <div>
                <button className="btn" onClick={() => onDownload(o.key)}>Download</button>
              </div>
            </div>
          ))}

          {data.nextToken && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn" onClick={() => load(data.nextToken)}>Load more…</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

**/web/.env.example**
```
VITE_API_BASE=http://localhost:4000
```

---

## Local Run

### Prefilled .env values (based on your details)

**/server/.env**
```
AWS_REGION=ap-south-1
# If running outside AWS, set these; otherwise remove and rely on the instance/role
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
S3_BUCKET=ti-hackathon-2025
PORT=4000
CORS_ORIGIN=http://localhost:5173
SIGNED_URL_TTL_SECONDS=900
```

**/web/.env**
```
VITE_API_BASE=http://localhost:4000
```

> Tip: if you host the server, point `VITE_API_BASE` to your server’s URL.



### 1) Start the server
```bash
cd server
cp .env.example .env
# edit .env to set AWS region, bucket, and credentials (or use an instance/role)
npm install
npm run dev
```

### 2) Start the web app
```bash
cd web
cp .env.example .env
npm install
npm run dev
# open http://localhost:5173
```

> Ensure `CORS_ORIGIN` in the server `.env` matches your web origin (e.g., `http://localhost:5173`).

---

## Notes & Options
- **Multipart uploads (>5 GB):** This example uses single-part PUT (up to 5 GB). For larger files, add server endpoints to create/complete multipart uploads and have the client upload parts in parallel via presigned URLs.
- **Serverless:** You can move the server endpoints to AWS Lambda + API Gateway; code remains the same.
- **Bucket policy:** You generally don’t need a bucket policy if the server uses IAM to call S3 and you keep objects private. If using an interface VPC endpoint for S3, add the right VPC endpoint policy.
- **Object ACLs:** Keep default (private). Downloads use signed URLs.
- **Rename/Move:** Implement by `CopyObject` then `DeleteObject`.
- **Audit/Access logs:** Enable S3 server access logging or CloudTrail data events.

---

## Security Checklist
- Do **not** put AWS keys in the frontend.
- Short-lived signed URLs (`SIGNED_URL_TTL_SECONDS`).
- Validate user auth (add your own auth layer before exposing these endpoints on the internet).
- Limit key prefixes if needed (e.g., scope users to `user-123/`).
- Consider S3 Object Ownership and Block Public Access settings.

---

## Minimal Docker (optional)

**root/Dockerfile.server**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/. ./
EXPOSE 4000
CMD ["npm","run","dev"]
```

**root/Dockerfile.web**
```dockerfile
FROM node:20-alpine as build
WORKDIR /app
COPY web/package.json ./
RUN npm install
COPY web/. ./
RUN npm run build

FROM node:20-alpine
RUN npm i -g serve
WORKDIR /site
COPY --from=build /app/dist ./
EXPOSE 5173
CMD ["serve","-s",".","-l","5173"]
```

---

## Docker Compose (one-command local run)

Create a file **docker-compose.yml** at the repo root:

```yaml
version: '3.9'
services:
  server:
    build:
      context: .
      dockerfile: Dockerfile.server
    environment:
      AWS_REGION: ap-south-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      S3_BUCKET: ti-hackathon-2025
      PORT: 4000
      CORS_ORIGIN: http://localhost:5173
      SIGNED_URL_TTL_SECONDS: 900
    ports:
      - "4000:4000"
    volumes:
      - ./server:/app

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    environment:
      - VITE_API_BASE=http://server:4000
    ports:
      - "5173:5173"
    depends_on:
      - server
```

### Run it:
```bash
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173).

---

## Docker Compose (one-command run)

Create **docker-compose.yml** at the repo root (next to `root/` and the `server/` & `web/` folders):

```yaml
version: "3.9"

services:
  server:
    build:
      context: .
      dockerfile: root/Dockerfile.server
    env_file:
      - server/.env
    ports:
      - "4000:4000"
    # Optional: live-edit server code on your machine
    volumes:
      - ./server:/app
      # Optional: use your local AWS CLI credentials instead of hardcoding keys
      - ~/.aws:/root/.aws:ro

  web:
    build:
      context: .
      dockerfile: root/Dockerfile.web
    env_file:
      - web/.env
    ports:
      - "5173:5173"
    depends_on:
      - server
```

### Run it
```bash
# At repo root
# Ensure you have the prefilled .env files from earlier sections
#   server/.env  (S3_BUCKET=ti-hackathon-2025, AWS_REGION=ap-south-1, etc.)
#   web/.env     (VITE_API_BASE=http://localhost:4000)

docker compose up --build
```

- Open the UI: **http://localhost:5173**
- The web app calls the server at **http://localhost:4000**
- Make sure `CORS_ORIGIN` in `server/.env` is `http://localhost:5173`.

> If you prefer not to place static AWS keys in `server/.env`, leave them blank and mount your local AWS credentials with the `~/.aws` volume shown above (uses the same chain as the AWS CLI).

---

## Docker Compose (Production profile)

Extend your `docker-compose.yml` with a production profile:

```yaml
version: "3.9"

services:
  server:
    build:
      context: .
      dockerfile: root/Dockerfile.server
    env_file:
      - server/.env
    ports:
      - "4000:4000"
    volumes:
      - ~/.aws:/root/.aws:ro
    profiles: ["prod"]
    command: npm run start  # production start script
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  web:
    build:
      context: .
      dockerfile: root/Dockerfile.web
    env_file:
      - web/.env
    ports:
      - "80:5173"   # expose on port 80 for production
    depends_on:
      - server
    profiles: ["prod"]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5173"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Run it in production mode
```bash
docker compose --profile prod up --build -d
```

- The server runs with `npm run start` instead of `dev`.
- Restarts automatically if it crashes.
- Healthchecks ensure container status is visible via `docker ps`.
- Web is exposed on port **80**.

---

## Troubleshooting
- **403 AccessDenied**: Check the server IAM policy and region/bucket names.
- **CORS errors**: Ensure the server `CORS_ORIGIN` matches your web origin.
- **Download prompts as inline**: The server adds `Content-Disposition` in presign so the browser downloads.
- **Folder not showing**: Remember S3 doesn’t have real folders; ensure keys end with `/`.

---

## Next Steps
- Add login + per-user prefixes.
- Add drag-and-drop uploads & multi-file uploads.
- Add rename/copy.
- Add thumbnails for images using S3 batch or Lambda triggers.

