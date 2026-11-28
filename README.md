# Hydrop Deepo

Hydrop Deepo is a web app for a single-branch water refilling station. It brings refill and merchandise sales, inventory management, an activity calendar, and an Owner dashboard for sales and stock reports into one place. The app uses React and TypeScript with Vite, an Express API, and PostgreSQL.

## Run locally

You’ll need Git and Node.js 22 or newer with npm. A fresh clone uses a built-in local database (PGlite) and applies migrations automatically. No separate database or Supabase account is required.

1. Clone the repository and install dependencies.

   ```sh
   git clone https://github.com/jasterdmndl/Hydrop-Deepo.git
   cd Hydrop-Deepo
   npm ci
   ```

2. Create the local database directory and an Owner account before starting the server.

   ```sh
   mkdir server/.data
   npm run provision "--" --username owner --role OWNER
   ```

   The terminal prints a temporary password once. Keep it private and change it when prompted at first sign-in.

3. From the repository root, start the API in one terminal and leave it running.

   ```sh
   npm run dev:server
   ```

4. From the same directory in a second terminal, start the web app.

   ```sh
   npm run dev:web
   ```

5. Open [http://localhost:5173](http://localhost:5173) and sign in as `owner`. The API runs on port `3000`.
