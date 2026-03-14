# PrintKaaro Backend API

Node.js + Express + MongoDB backend for PrintKaaro print store.

## Quick Setup

### 1. Install dependencies
```bash
cd printkaaro-backend
npm install
```

### 2. Configure environment
```bash
copy .env.example .env
```
Edit `.env` and add your MongoDB connection string.

### 3. Run locally
```bash
npm run dev
```
Server starts at http://localhost:4000

### 4. Deploy to Render
1. Push to GitHub
2. Go to render.com → New Web Service
3. Connect your repo → select `printkaaro-backend`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add environment variables from `.env`
7. Deploy!

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/signup | Create account |
| POST | /api/auth/signin | Login |
| GET | /api/auth/me | Get profile |
| PUT | /api/auth/me | Update profile |
| POST | /api/auth/address | Add address |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/orders/upload | Upload PDF file |
| POST | /api/orders | Create order |
| GET | /api/orders/my | My orders |
| GET | /api/orders/:id | Order details |
| GET | /api/orders/:id/file | Download PDF |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/admin/login | Admin login |
| GET | /api/admin/stats | Dashboard stats |
| GET | /api/admin/orders | All orders |
| PATCH | /api/admin/orders/:id/status | Update status |
| PATCH | /api/admin/orders/:id | Edit order |
| PATCH | /api/admin/orders/:id/tracking | Add tracking |
| GET | /api/admin/customers | Customer list |
| POST | /api/admin/orders/manual | Add walk-in order |

## Project Structure
```
printkaaro-backend/
├── server.js          ← Main entry point
├── models.js          ← User & Order schemas
├── middleware.js       ← Auth middleware
├── routes-auth.js     ← Signup, login, profile
├── routes-orders.js   ← Orders + PDF upload
├── routes-admin.js    ← Admin dashboard API
├── .env.example       ← Config template
├── .gitignore
├── package.json
└── uploads/           ← PDF files (auto-created)
```
