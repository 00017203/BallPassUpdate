# BallPass – Football Ticket Exchange

A secure peer-to-peer football ticket exchange platform.

## Live Demo
Deployed at: [your-render-url-here]

**Demo account:** demo@ballpass.com / demo1234

## Tech Stack
- Node.js + Express.js (backend)
- PostgreSQL (database)
- HTML5 / CSS3 / JavaScript (frontend)
- Three.js (3D seat view)
- Chart.js (analytics)
- bcryptjs (password hashing)
- express-session (authentication)

## Local Development

### Prerequisites
- Node.js v18+
- PostgreSQL database

### Setup
1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Set environment variables:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/ballpass
   SESSION_SECRET=your-secret-key
   ```
4. Start the server:
   ```
   npm start
   ```
5. Open http://localhost:3000

## Deployment (Render)
See deployment instructions below.

## Features
- User registration and login with bcrypt password hashing
- Account verification via 6-digit code
- Buyer / Seller mode system
- Ticket listing with validation
- Interactive seat selector (2D map + 3D first-person view)
- Purchase system with transaction records
- Print ticket with booking reference
- Seller dashboard with revenue analytics
- Buyer dashboard with market trends
- Landing page with live platform statistics
