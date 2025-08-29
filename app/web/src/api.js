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
