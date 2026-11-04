# KaamSetu

Hire and find local workers. One small Node server: it serves the site (`public/index.html`) and the `/api`
(real SMS OTP login, employee and business dashboards, admin, plans).

## 1. Get SMS OTP working (Twilio Verify)
1. Create a Twilio account, then **Verify > Services > Create new** (name it KaamSetu, channel SMS).
2. Copy the **Account SID**, **Auth Token** and the **Verify Service SID** (starts with `VA`).
3. Sending SMS to Indian numbers has local rules (DLT registration). Read Twilio's India SMS guidance
   before going live. To use MSG91 or another provider instead, replace the small `otp` block in `server.js`.

## 2. Put it on GitHub
```bash
cd kaamsetu
git init
git add .
git commit -m "KaamSetu"
git branch -M main
git remote add origin https://github.com/<your-username>/kaamsetu.git   # create the empty repo on github.com first
git push -u origin main
```
`.env` and `data.json` are in `.gitignore`, so no secrets are uploaded.

## 3. Launch on Render
1. render.com > **New + > Blueprint** > choose the GitHub repo. Render reads `render.yaml` and creates the web service and the database.
2. Fill in the values it asks for: `ADMIN_USER`, `ADMIN_PASSWORD` (pick a strong one), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`.
3. Click **Apply**. When it is live, open the `.onrender.com` link, sign up with your own number and check that the SMS arrives.
4. Admin: on the site use **Staff login** with your `ADMIN_USER` / `ADMIN_PASSWORD`. New employees and businesses start as *pending* until you verify them there.

The server refuses to start in production without `SECRET` and an OTP provider, so it can never go live with fake OTPs by accident.

## Before real users arrive (free-plan limits)
- Free web services sleep after 15 minutes idle, so the first visit can take about a minute. Use the **Starter** plan for the web service.
- A free Render database expires 30 days after creation (14 days grace, then deleted). Switch the database to a paid plan, or use an outside Postgres (Neon, Supabase) and paste its URL into `DATABASE_URL`.
- Check Render's current pricing page, as free-tier terms change.

## Payments (optional, Razorpay)
Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and `PUBLIC_URL`. In the Razorpay dashboard add a webhook to
`https://<your-app>/api/razorpay/webhook` for the event `payment_link.paid`. A paid plan switches on only after that webhook arrives.
This part is written to Razorpay's API but has not been tested against a live account, so test with a small payment in test mode first.
Without these keys, paid plans cannot be activated.

## Run locally
```bash
npm install
OTP_PROVIDER=dev ADMIN_USER=admin ADMIN_PASSWORD=admin123 node server.js   # OTP 123456, data in data.json
```
Open http://localhost:3000

## Good to know
- Data is stored as one JSON document (Postgres when `DATABASE_URL` is set, otherwise `data.json`). Fine for launch and early growth; move to proper tables if you grow large.
- Photos are limited to 300 KB and stored in that same document.
- The Mukadam chat answers from built-in replies. It is not connected to an AI model.
