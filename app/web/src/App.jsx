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
