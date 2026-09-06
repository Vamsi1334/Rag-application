# Deploying to GitHub and Vercel

Deploying this phase, while it is small, rather than later when it is not. The
whole thing takes about twenty minutes, and most of that is waiting.

There are four parts and they have to happen in this order, because each one
needs a value produced by the one before it.

---

## Before you start

Three things are already true, and they are the things that usually go wrong:

- **`.gitignore` is correct.** `.env.local` cannot be committed. There is an
  explicit check below that proves it rather than assuming it.
- **No real credential exists anywhere in the code.** Every `GOCSPX-`,
  `gsk_` and connection string in this repository is a regex pattern, a
  documentation placeholder, or a deliberately fake test fixture such as
  `hunter2`. Audited before the first commit.
- **The build works with no environment variables at all**, which is what
  Vercel's build step looks like. Nothing fails at build time for want of a
  secret.

---

## Part 1: Git and GitHub

### 1. Set your identity, if you have not before

Every commit records a name and an email. Do this once per machine:

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

**This email becomes public** in the commit history of a public repository. If
you would rather not publish your personal address, GitHub gives you a
`@users.noreply.github.com` address under Settings, Emails. Use that instead.

### 2. Initialise the repository

From the project folder:

```powershell
git init
git add .
```

### 3. Prove `.env.local` is not staged

**Do not skip this.** It is the whole ballgame for a public repo.

```powershell
git check-ignore -v .env.local
```

You want output naming the rule that excluded it, something like:

```
.gitignore:20:.env.*    .env.local
```

**Blank output means it is NOT ignored. Stop and fix `.gitignore` before
committing.**

Second check, listing what is actually about to be committed:

```powershell
git status --short
```

Read the list. `.env.local` must not appear. Neither should `node_modules`,
`.next`, or anything ending in `.log`.

### 4. Commit

```powershell
git commit -m "Phase 4: Google authentication and hosted generation"
```

### 5. Create the GitHub repository

Go to <https://github.com/new>. Name it, choose **Public**, and create it
**empty**: no README, no `.gitignore`, no licence. You already have those, and
adding them there means a merge conflict on your first push.

Then connect and push, substituting your username and repository name:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```

### 6. Look at what you published

Open the repository on GitHub and check that `.env.local` is not in the file
list. If it is, treat every credential in it as compromised and rotate all of
them: deleting the file in a later commit does not remove it from the history.

---

## Part 2: Vercel

### 1. Import the repository

Go to <https://vercel.com/new>, sign in with GitHub, and import the repository.
Vercel detects Next.js on its own. Leave the build settings alone.

### 2. Set the environment variables

Before the first deploy, add these under **Environment Variables**. Three of
them are deliberately different from your `.env.local`.

| Variable | Value | Same as local? |
| --- | --- | --- |
| `MONGODB_URI` | your Atlas connection string | same |
| `MONGODB_DB_NAME` | `ai_document_assistant_prod` | **different** |
| `AUTH_SECRET` | a freshly generated one | **different** |
| `GOOGLE_CLIENT_ID` | your Web client id | same |
| `GOOGLE_CLIENT_SECRET` | your Web client secret | same |
| `LLM_PROVIDER` | `groq` | same |
| `GROQ_API_KEY` | your Groq key | same |
| `APP_URL` | fill in after the first deploy | **different** |
| `NEXT_PUBLIC_APP_URL` | fill in after the first deploy | **different** |

Generate the production `AUTH_SECRET` yourself:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Why a different secret.** It signs session cookies. Sharing one between your
laptop and production means a session minted on either is valid on both, and a
leaked development secret becomes a way into the live app. They are separate
systems, so they get separate keys.

**Why a different database name.** Same cluster, still free, but production
never reads a row your laptop wrote. Otherwise a throwaway test sign-in lands
in the same collection as real users, and one bad experiment corrupts real
data.

`NODE_ENV` is not in that table on purpose. Vercel sets it to `production`
automatically, and overriding it breaks things.

### 3. Deploy

Click Deploy and wait. **The first deploy will build fine and sign-in will not
work yet.** That is expected: Google does not know the URL yet, and neither
does the app. Both are fixed in Part 3.

Note the URL you were given, something like
`https://your-repo.vercel.app`.

### 4. Set the two URL variables

Back in Settings, Environment Variables, fill in the two you left blank:

```
APP_URL=https://your-repo.vercel.app
NEXT_PUBLIC_APP_URL=https://your-repo.vercel.app
```

No trailing slash. Then **Deployments, and redeploy**. Environment variables
are read at build and boot, so changing them does nothing until you redeploy.

---

## Part 3: Wire up Google and Atlas

Both of these are outside the code, and both will block sign-in until done.

### Google: add the production redirect URI

Cloud Console, Clients, your **Web client**, Authorized redirect URIs, **Add
URI**:

```
https://your-repo.vercel.app/api/auth/callback/google
```

Keep the localhost one. A client can hold several, which is how one client
serves both development and production.

Note `https` here, not `http`. Vercel serves over HTTPS and the URI must match
exactly.

Google can take a few minutes to apply this.

### Atlas: allow connections from Vercel

Atlas, Network Access, Add IP Address, **Allow Access From Anywhere**
(`0.0.0.0/0`).

**Read this before you click it.** Vercel runs your code on shared
infrastructure with no fixed IP address, so there is nothing specific to
allowlist. Opening it to everywhere is the only option on a free plan.

What that changes: the IP allowlist stops protecting anything, and your
**database password becomes the only thing between the internet and your
data**. It needs to be a generated string that exists in exactly two places,
your `.env.local` and Vercel's environment variables, and nowhere else. Not in
a chat, not in a note, not in a commit.

This is the security tradeoff of a free-tier deployment, taken knowingly.

---

## Part 4: Verify

In this order, because each answer narrows the next.

**1. The app is alive and its config parsed:**

```
https://your-repo.vercel.app/api/health
```

Every check should read `ok` except `embeddings`, which is `not_implemented`
until the next phase. If `authentication` says `not_configured`, a variable is
missing in Vercel. If `llm` says it, `GROQ_API_KEY` did not get set.

**2. The database is genuinely reachable**, not merely configured:

```
https://your-repo.vercel.app/api/health/db
```

Wants `{"status":"ok","latencyMs":...}`. An `unavailable` here is almost always
the Atlas allowlist not yet applied.

**3. The endpoint is closed to strangers.** Open this in a private window,
signed out:

```
https://your-repo.vercel.app/api/ai/chat
```

A `405` (wrong method for a browser GET) or a `401` is correct. An answer would
mean the endpoint is open, which would be the serious one.

**4. Sign in.** Go to `/login`, sign in with Google, land on `/dashboard`.

**5. Ask a question** at `/ai-test`. You should get an answer with token counts.

---

## Things that will surprise you

**Preview deployments cannot sign in.** Every branch and pull request gets its
own URL, and none of them are in Google's redirect list. Sign-in fails there
with `redirect_uri_mismatch`. That is correct behaviour, not a bug. Adding
every preview URL to Google is not worth it; test auth on production.

**Changing an environment variable does nothing until you redeploy.** This
catches everyone once.

**The error messages get quieter in production.** The development-only panel on
`/login` that names the exact failing variable does not render there, on
purpose: it is a public page and listing your missing configuration is free
reconnaissance. Use `/api/health` instead, which reports status without values.

**Cold starts are slow.** A serverless function that has not run recently pays
to start up and open a database connection. The first request after a quiet
period can take a few seconds. This is not your code being slow.

**Your Groq limits do not change.** 30 requests a minute and 200,000 tokens a
day are per account, not per environment. Your laptop and your deployment draw
from the same budget.

---

## If you need to roll back

Vercel keeps every deployment. Deployments, find the last good one, and
**Promote to Production**. It is instant and does not need a rebuild.

For the code itself, the commit before is one `git revert` away. This is the
other reason to be in Git before you deploy rather than after.
