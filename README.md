# Merchandise Tracker

Tracks club clothing stock, who ordered what, whether they paid, and when they
received it. Sales from the Wix shop come in automatically and reduce stock.

Owned by the club, not by any individual. Everything below assumes a club GitHub
organisation rather than a personal account.

---

## What you're setting up

| Piece | What it does | Cost |
|---|---|---|
| GitHub (private repo) | Stores the code | Free |
| Supabase | The database and the login system | Free tier |
| Vercel | Runs the app, gives you a URL | Free tier |

You do not need Cloudflare. Vercel handles HTTPS, the CDN, and DNS.

---

## Setup

Allow about 45 minutes the first time. Do the steps in order.

### 1. Create the GitHub organisation and repo

1. Go to GitHub → your profile menu → **Your organizations** → **New organization** → Free plan.
2. Name it after the club, e.g. `westside-fc`.
3. Invite two or three committee members and set them as **Owners**, so access
   survives someone leaving.
4. Create a new repository inside the org called `merch-tracker`. Set it to **Private**.
5. Push this folder to it:

```bash
cd merch-tracker
git init
git add .
git commit -m "Initial merchandise tracker"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/merch-tracker.git
git push -u origin main
```

Turn on two-factor authentication for the org owners. This is the account that
matters most.

### 2. Create the Supabase project

1. Sign up at supabase.com and create a new project. Choose the Sydney region.
2. Set a database password and save it in the club's password manager.
3. Wait about two minutes for the project to finish provisioning.

### 3. Create the database tables

1. In Supabase, open **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this repo, copy the whole file, paste it in.
3. **Before running it**, scroll to the bottom and change
   `your-email@gmail.com` to your own email address. This is how you get in the
   first time.
4. Click **Run**. You should see "Success".

### 4. Turn off public sign-up

This is the step that keeps strangers out.

1. Supabase → **Authentication** → **Providers** → **Email**.
2. Turn **Enable email signups** OFF.
3. Turn **Confirm email** ON.

Now only people you add to the `members` table can sign in, and there's no
public registration form.

### 5. Collect your keys

Supabase → **Project Settings** → **API**. You need three values:

- Project URL
- `anon` public key
- `service_role` secret key

The `service_role` key is powerful. It goes in Vercel's environment variables
only. Never put it in the code, and never paste it into a chat or email.

### 6. Deploy to Vercel

1. Sign up at vercel.com using your GitHub account.
2. **Add New** → **Project** → import `merch-tracker` from the club org.
3. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | The service_role key |
| `CRON_SECRET` | Any long random string you invent |

4. Click **Deploy**. After a couple of minutes you'll have a URL like
   `merch-tracker.vercel.app`.

### 7. Tell Supabase where the app lives

1. Supabase → **Authentication** → **URL Configuration**.
2. Set **Site URL** to your Vercel URL.
3. Add `https://your-app.vercel.app/auth/callback` under **Redirect URLs**.

Without this, the sign-in links won't work.

### 8. Sign in

Visit your URL, enter the email you put in the schema file, and click the link
that arrives in your inbox. You're in.

---

## Adding committee members

Use the **Admin** page (the avatar menu, top right — only admins see it), not
the Supabase dashboard.

- **Invitations** is the normal way to add someone: enter their email, role
  (`admin` or `helper`), and which of the four permissions to grant
  (adjusting stock, changing prices, changing targets, undoing a handover —
  admins get all four regardless of the checkboxes). They get an email with a
  sign-in link; the committee-list row is created automatically once they
  click it. Invitations expire after 7 days — re-send or revoke from the same
  page.
- **Add directly** creates the row without emailing an invitation, for fixing
  someone's role or adopting an account that already exists.

To remove someone, use **Remove** on their row in the Committee table — this
deletes both their committee-list row and their sign-in account, so they're
locked out immediately.

---

## Connecting the Wix shop

Do this after the basics are working.

1. In your Wix dashboard, generate an API key with eCommerce read permissions,
   and find your Site ID.
2. Add `WIX_API_KEY` and `WIX_SITE_ID` to the Vercel environment variables, then
   redeploy.
3. For each item in the tracker, click **Adjust** and paste in the matching Wix
   product ID. Items without an ID won't sync — the tracker will tell you which
   ones it couldn't match.

The sync runs every hour automatically. It only imports paid orders, and it will
never create the same order twice, so re-running it is always safe.

---

## Running it on your own machine

Only needed if you're changing the code.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000.

---

## Things worth knowing

**Stock adjusts itself.** Recording an order reduces stock automatically.
Deleting an order puts it back. Every change is logged in `stock_movements`, so
you can always explain a number.

**Nothing is truly deleted from the audit trail.** If a count looks wrong, check
the `stock_movements` table in Supabase to see what happened and when.

**Free tier limits.** Supabase pauses a project after a week with no activity —
it wakes on the next visit. If the club uses this weekly you'll never notice.

**Deploying a change.** Push to `main` on GitHub and Vercel redeploys on its own.
