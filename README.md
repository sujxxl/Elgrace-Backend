# Elgrace Backend – Upload & Media API

This repository contains the **Elgrace backend service** responsible for:

- Authenticated media uploads (profile photo, portfolio images, intro video)
- Storing files on the VPS filesystem
- Serving media securely via **nginx over HTTPS**
- Storing media metadata in **Supabase (Postgres)**
- Running persistently via **PM2**

This service is designed to be **stateless, production-safe, and migration-friendly**.

---

## 🧱 Tech Stack

- **Node.js** (18+)
- **Express.js**
- **Multer** (file uploads)
- **Supabase** (Auth + Postgres)
- **PM2** (process manager)
- **nginx** (HTTPS reverse proxy + static media)

---

## 📁 Project Structure

```text
elgrace-backend/
├── server.js            # Main API
├── package.json
├── package-lock.json
├── .env                 # Environment variables (NOT committed)
├── .env.example         # Env template
├── .gitignore
└── README.md
```

---

## 🔐 Environment Variables (CRITICAL)

### Create `.env`

```bash
nano .env
```

```env
PORT=8093

SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY

MEDIA_ROOT=/var/www/media
MEDIA_BASE_URL=https://api.elgrace.in/media
```

### Notes

- `SUPABASE_SERVICE_ROLE_KEY`
  - Required for inserts/deletes
  - Bypasses RLS
  - **Never expose to frontend**

- `MEDIA_BASE_URL`
  - Public HTTPS URL served by nginx
  - Stored in DB and returned to frontend
  - **Must NOT use raw IPs or ports**

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

Expected:
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

## 📤 Upload Media

### Endpoint
```
POST /upload
```

### Headers
```
Authorization: Bearer <SUPABASE_ACCESS_TOKEN>
```

### multipart/form-data

| Field       | Type | Values                         |
|------------|------|--------------------------------|
| file       | File | image / video                  |
| media_role | Text | profile | portfolio | intro_video |

### Behavior

- **profile**
  - Single file
  - Always replaced
  - Filename: `profile.jpg`

- **intro_video**
  - Single file
  - Always replaced
  - Filename: `intro_video.mp4`

- **portfolio**
  - Multiple files allowed
  - Timestamp-based filenames

---

## 📥 Fetch Media

```
GET /media?model_id=<MODEL_UUID>
```

Response example:
```json
[
  {
    "id": "...",
    "model_id": "...",
    "media_role": "profile",
    "media_type": "image",
    "media_url": "https://api.elgrace.in/media/...",
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
- Auth required
- Only owner can delete
- File removed from disk and DB

---

## 🗄️ Database

### `model_media`

Stores all uploaded media.

Rules:
- One row per `(model_id, media_role)` for:
  - `profile`
  - `intro_video`
- Multiple rows allowed for:
  - `portfolio`

Enforced via **partial unique indexes**.

---

## 🔒 Supabase + RLS Notes

- Backend uses **Service Role Key**
- Service role bypasses RLS
- Frontend must use **anon key only**

---

## 🌍 Media Serving (IMPORTANT)

- Files stored at:
  ```
  /var/www/media
  ```

- Served via nginx:
  ```
  https://api.elgrace.in/media/...
  ```

- Backend generates HTTPS URLs only
- Frontend never uses raw IPs or ports

---

## 🔁 Migration

1. Copy `/var/www/media`
2. Copy `.env`
3. Clone repo
4. `npm install`
5. `pm2 start server.js`

---

## ✅ Status

✔ Production-ready  
✔ HTTPS enforced  
✔ nginx-backed media  
✔ Supabase-integrated  
✔ PM2-managed  

---

Maintained by **Elgrace Technical Team**
