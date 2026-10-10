# MediStock — Pharmacy Management System

A modern pharmacy management website built with HTML, CSS, JavaScript, Node.js, Express and MySQL.

## Features

- Secure session-based login and password hashing
- Dashboard with sales, stock and expiry summaries
- Medicine CRUD: add, edit, delete and search medicine batches
- Batch number, manufacturer, quantity, reorder level, unit price and expiry date
- Low-stock and expiry status indicators
- Billing/cart with quantity checks and stock deduction
- Prescription-required medicine confirmation
- Printable invoices
- Sales history and 30-day revenue reports
- Top-selling medicine summary
- CSV exports for medicines and sales
- Responsive layout for desktop and mobile

## Requirements

Install:
1. Node.js LTS: https://nodejs.org/
2. MySQL Community Server: https://dev.mysql.com/downloads/mysql/
3. Visual Studio Code: https://code.visualstudio.com/

## Setup (Windows + VS Code)

1. Extract `pharmacy-management-system.zip`.
2. Open the extracted `pharmacy-management-system` folder in VS Code.
3. Start your MySQL server.
4. Open a terminal in VS Code (**Terminal → New Terminal**).
5. Install dependencies:

   ```bash
   npm install
   ```

6. Copy `.env.example` to a new file named `.env`.
7. Edit `.env` and enter your MySQL username/password. If your local MySQL root account has no password, leave `DB_PASSWORD=` blank.
8. Create the database:
   - Open MySQL Workbench or MySQL command line.
   - Run the contents of `schema.sql`.
   - The server also creates the tables at startup, but the database itself must exist first.

   Or use the MySQL terminal:

   ```sql
   CREATE DATABASE pharmacy_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

9. Start the website:

   ```bash
   npm start
   ```

10. Open this URL in your browser: **http://localhost:3000**

## First login

- Username: `admin`
- Password: `Admin@123`

The first run creates this demo administrator automatically if the account does not exist. Change this demo password before storing real pharmacy data. The demo account is for local development only.

## Important: Live Server vs. Node.js

Do **not** open this project using the VS Code Live Server extension alone. Live Server cannot run the Express API or connect to MySQL. Run `npm start` in the VS Code terminal, then visit `http://localhost:3000`.

## Troubleshooting

- **`ECONNREFUSED` / database connection error:** Make sure MySQL is running and check `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` in `.env`.
- **Unknown database `pharmacy_db`:** Create it with `CREATE DATABASE pharmacy_db;`.
- **`npm` is not recognized:** Install Node.js LTS, close and reopen VS Code, then run `node -v` and `npm -v`.
- **Port 3000 in use:** Set `PORT=3001` in `.env`, restart, and visit `http://localhost:3001`.
- **Invoice window does not open:** Allow pop-ups for `localhost`.

## Before real-world use

This is an educational starter project, not a certified pharmacy/POS product. Before using it for real sales, add production-grade security and operational controls: HTTPS, secure cookies, CSRF protection, login rate limiting, password-change/reset workflow, audit logging, automated database backups, proper staff permissions, tax/legal review, and pharmacist-approved prescription workflows. Do not store unnecessary patient or prescription data. Follow all applicable local medicine-dispensing, privacy, invoicing and record-retention laws.
