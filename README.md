# Elgrace Backend – Upload & Media API

This repository contains the **Elgrace backend service** responsible for:

- Authenticated media uploads (profile photo, portfolio images, intro video)
- Storing files on a VPS (`/var/www/media`)
- Storing metadata in Supabase (`model_media` table)
- Fetching and deleting uploaded media
- Running persistently via PM2

This README is intentionally **very explicit** so even someone new to backend + VPS can set it up or migrate it.

---

## 🧱 Tech Stack

- **Node.js** (18 works, 20+ recommended)
- **Express.js**
- **Multer** (multipart uploads)
- **Supabase** (Auth + Postgres)
- **PM2** (process manager)
- **VPS file storage** (Apache/Nginx static server)

---

## 📁 Project Structure

```text
elgrace-backend/
├── server.js               # Main API
├── package.json
├── package-lock.json
├── node_modules/           # Dependencies (NOT committed manually)
├── .env                    # Environment variables (DO NOT COMMIT)
├── .env.example            # Env template (committed)
├── .gitignore
└── README.md
````

---

## 🔐 Environment Variables (CRITICAL)

### Where env variables are stored

* **Primary source**: `.env` file in project root
* **PM2** reads env from `.env` at startup
* Env variables are **NOT stored in Git**
* If `.env` is deleted → backend breaks

### Create `.env`

```bash
nano .env
```

```env
PORT=8093

SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY

MEDIA_BASE_URL=http://YOUR_VPS_IP:8092
```

### Important notes

* `SUPABASE_SERVICE_ROLE_KEY`

  * Required for inserts / deletes
  * Bypasses RLS
  * **Must never be exposed to frontend**

* `MEDIA_BASE_URL`

  * Must match your Apache/Nginx static media server
  * Example:

    ```
    http://72.61.233.139:8092
    ```

---

## 📦 Install Dependencies

```bash
npm install
```

---

## ▶️ Run Locally (Debug)

```bash
node server.js
```

Test:

```bash
curl http://localhost:8093
```

Expected response:

```text
Upload API running
```

---

## 🚀 Run in Production (PM2)

```bash
npm install -g pm2
pm2 start server.js --name elgrace-upload-api
pm2 save
pm2 startup
```

Restart after env changes:

```bash
pm2 restart elgrace-upload-api --update-env
```

Logs:

```bash
pm2 logs elgrace-upload-api
```

---

## 📤 Upload Media API

### Endpoint

```
POST /upload
```

### Headers

```
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
```

### multipart/form-data fields

| Field      | Type | Value                             |
| ---------- | ---- | --------------------------------- |
| file       | File | image / video                     |
| media_role | Text | profile | portfolio | intro_video |

### Behavior

* **profile**

  * Always replaced
  * File name: `profile.jpg`
  * One row per model

* **intro_video**

  * Always replaced
  * File name: `intro_video.mp4`
  * One row per model

* **portfolio**

  * Multiple allowed
  * Timestamp-based filenames

---

## 📥 Fetch Media

```
GET /media?model_id=<MODEL_UUID>
```

Returns:

```json
[
  {
    "id": "...",
    "model_id": "...",
    "media_role": "profile",
    "media_type": "image",
    "media_url": "http://...",
    "created_at": "..."
  }
]
```

---

## 🗑️ Delete Media

```
DELETE /media?id=<MEDIA_ID>
```

Rules:

* Auth required
* Only owner can delete
* File removed from disk + DB

---

## 🗄️ Database Tables Used

### `model_media`

Used for **all media**.

Rules:

* `(model_id, media_role)` is **unique** for:

  * `profile`
  * `intro_video`
* `portfolio` allows multiple rows

This uniqueness is enforced via **partial unique indexes**.

---

## 🔒 Supabase + RLS Notes (IMPORTANT)

* Backend uses **Service Role Key**
* Service role **bypasses RLS**
* Frontend must **never** use service role

Common RLS error you may see:

```
new row violates row-level security policy
```

This means:

* Wrong key used
* Or insert attempted from frontend instead of backend

---

## ❗ Common Errors & Fixes

### ❌ `42P10: no unique constraint matching ON CONFLICT`

**Cause**

* `onConflict` used without a matching unique index

**Fix**

* Use correct partial unique index
* Or fallback to manual delete + insert

(Current backend handles this safely.)

---

### ❌ `22003: value out of range for type integer`

**Cause**

* Using `Date.now()` in `integer` column

**Fix**

* Do NOT use timestamps in `sort_order`
* Use `null` or small integers

---

### ❌ `403 Invalid token`

**Cause**

* Expired Supabase session
* Missing `Authorization: Bearer`

---

### ❌ Media uploads but not visible

**Checklist**

* Apache/Nginx serving `/var/www/media`
* `MEDIA_BASE_URL` correct
* Browser console not blocking mixed content

---

## 🌍 Static Media Server

Your VPS must serve:

```
/var/www/media
```

Example Apache config:

```apache
Alias /models /var/www/media/models
<Directory /var/www/media>
  Require all granted
</Directory>
```

---

## 🔁 Migration Friendly Design

This backend is **stateless**.

To migrate servers:

1. Copy `/var/www/media`
2. Copy `.env`
3. Clone repo
4. `npm install`
5. `pm2 start server.js`

Nothing else required.

## ✅ Status

✔ Production-ready
✔ VPS tested
✔ Supabase-integrated
✔ PM2-managed
✔ Migration-safe

---

## 👨‍💻 Maintained By

**Elgrace Technical Team**
Backend designed for long-term scaling.
