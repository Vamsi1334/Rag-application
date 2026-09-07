# AI Document Assistant

Upload your documents, ask questions about them, and get answers that cite the
exact passages they came from.

The application is built on **RAG** (retrieval-augmented generation). A language
model has never seen your documents and cannot look anything up, so before it is
asked a question, the system finds the handful of passages from your own files
most likely to contain the answer and puts them in the prompt. The model reads
them fresh each time and answers from them, citing what it used.

> **Status: Phase 5 of 17 complete.** Foundation, database, Google sign-in, a
> model layer that switches provider by changing one line, and now the
> embedding half of the stack: Voyage, chunking, and the vector index.
>
> You can sign in, reach a protected dashboard, and ask Groq a question. Text
> can be chunked, embedded and stored with its owner. What does not exist yet
> is document **upload**, PDF parsing and the retrieval query itself, so the
> model still answers from training rather than from your documents. Those are
> the next phase.

---

## Technology stack

| Layer | Choice | Version | Why |
| --- | --- | --- | --- |
| Framework | Next.js (App Router) | 16.3.4 | Frontend, API routes and streaming in one deployable unit |
| Language | TypeScript (strict) | 6.0.3 | See the version note below |
| UI | React | 19.2.8 | Server Components by default |
| Styling | Tailwind CSS | 4.3.3 | One dependency, no config file in v4 |
| Database | MongoDB Node.js driver | 7.6.0 | See the driver note below |
| Local models | Ollama | 0.33+ | Runs an LLM on your machine. See below. |
| Authentication | Auth.js (next-auth) | 5.0.0-beta | Google OAuth with database sessions |
| Auth storage | @auth/mongodb-adapter | 3.11.3 | Users, accounts and sessions in MongoDB |
| Validation | Zod | 4.5.4 | Environment, write inputs, and later model output |
| Logging | Pino | 10.3.1 | Structured JSON logs |
| Linting | ESLint + eslint-config-next | 9.39.5 | See the version note below |
| Testing | Vitest | 5.0.0 | Fast, native ESM and TypeScript |
| Test database | mongodb-memory-server | 11.2.0 | Real MongoDB for integration tests, no setup |
| Boundary guard | server-only | 0.0.1 | Build fails if client code imports server code |

**Planned but not installed yet.** Auth.js, document parsers, file storage,
rate limiting and error monitoring arrive in the phase that needs them. Nothing
is installed before it is used.

### A version note on the MongoDB driver

The driver is pinned to **6.21.0, not 7.x**. `@auth/mongodb-adapter` declares a
peer dependency of `mongodb: ^6`, and installing it against 7 fails outright.
Driver 6 is fully current and nothing in this project needs a 7-only API, so
downgrading was the honest fix rather than forcing a peer override on the
library that manages user identity. The Phase 2 integration suite was re-run
against 6 to prove nothing broke.

`next-auth` is on `5.0.0-beta`. That has been the state of v5 for a long time
and it is what the App Router documentation targets; v4 does not support this
routing model well.

### Why the native driver and not Mongoose

Four reasons, the last one decisive:

1. Vector search later uses a `$vectorSearch` aggregation with a filter on
   fields declared in the Atlas index. That pipeline has to be exactly right,
   and an ODM's translation layer sits directly on top of it.
2. Mongoose's model registry conflicts with Next.js hot reload, which is why
   every Mongoose-plus-Next guide carries an `OverwriteModelError` workaround.
3. Chunks hold 256-element float arrays; ODM casting on those is overhead for
   no benefit.
4. Auth.js's MongoDB adapter, arriving next phase, takes a native
   `MongoClient`. Using Mongoose would mean running both.

Validation still happens, through Zod at the repository boundary. One schema
definition instead of two that can drift apart.

### Two deliberate version choices

**TypeScript is pinned to 6.0.3, not the newer 7.0.** TypeScript 7 is the
rewritten native compiler, but `typescript-eslint` (which `eslint-config-next`
depends on) declares support only up to `<6.1.0`. Upgrading now would mean
losing lint. Revisit once typescript-eslint supports TypeScript 7.

**ESLint is pinned to 9.39.5, not 10.** The plugins bundled with
`eslint-config-next` (`eslint-plugin-import`, `jsx-a11y`, `react`) declare peer
support only up to ESLint 9. Installing ESLint 10 produced peer conflicts on
five packages. npm prints a deprecation notice for 9.39.5; a working lint setup
is worth more than a clean notice. Revisit when the plugins ship ESLint 10
support.

---

## Prerequisites

- **Node.js 20.9 or newer.** Check with `node --version`. The build fails on
  older versions.
- **npm 10 or newer** (ships with Node 20+).

Nothing else is needed to run Phase 1. MongoDB Atlas, a Google OAuth client and
Ollama are set up in the phases that use them.

---

## Install

```bash
npm install
```

If you received this project as source files without `node_modules`, that is
expected and correct: dependency binaries are platform-specific, so they have to
be installed on the machine that will run them.

---

## Set up MongoDB Atlas

Free tier, about ten minutes, no card required.

1. **Create an account and a cluster** at <https://cloud.mongodb.com>. Choose
   **M0 (free)**. Pick the region closest to you; every query pays the round
   trip, so distance is felt.
2. **Create a database user.** Security > Database Access > Add New Database
   User. Use password authentication and let Atlas generate the password, which
   avoids characters that need percent-encoding in a URI. Give it
   **Read and write to any database**. Save the password now: Atlas will not
   show it again.
3. **Allow your IP.** Security > Network Access > Add IP Address >
   **Add Current IP Address**. If your home connection changes address you will
   need to add the new one; a connection failure that looks like a timeout is
   usually this.
4. **Copy the connection string.** Database > Connect > Drivers > Node.js. It
   looks like:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

   Replace `PASSWORD` with the real one. Paste it into `MONGODB_URI` in
   `.env.local` and nowhere else.

5. **Verify.** Start the app and open <http://localhost:3000/api/health/db>. A
   healthy connection returns `{"status":"ok"}` with a latency figure.

A note on the free tier: M0 pauses after inactivity, so the first request after
a quiet period can take a few seconds while the cluster wakes. That is normal
and not a bug in the connection code.

**Never paste a connection string into a chat, an issue, a commit or a
screenshot.** It contains a password that grants full read and write access to
your data.

---

## Configure environment variables

Copy the template and edit your copy:

```powershell
# Windows PowerShell
Copy-Item .env.example .env.local
```

```bash
# macOS / Linux
cp .env.example .env.local
```

**`.env.local` is gitignored and is the only place real values belong.** Every
variable is documented inline in `.env.example`.

Nothing in it is required to start the app. Variables for features that do not
exist yet are optional, and the health check reports which are set.

| Variable | Required for | Notes |
| --- | --- | --- |
| `MONGODB_URI` | Documents, conversations | Secret. Contains your password. |
| `MONGODB_DB_NAME` | Documents, conversations | Defaults to `ai_document_assistant`. Give each environment its own. |
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | Links and OAuth callbacks | http or https only. |
| `LOG_LEVEL` | Nothing; tuning | `silent` through `trace`. Defaults to `info`. |
| `AUTH_SECRET` | Sign-in | Secret. Signs the session cookie, min 32 chars. |
| `GOOGLE_CLIENT_ID` | Sign-in | From Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | Sign-in | Secret. Server-side only, never bundled. |
| `LLM_PROVIDER` | Asking the model | Defaults to `groq`. Set `ollama` to run locally with no key. |
| `GROQ_API_KEY` | Hosted generation | Secret. Free at console.groq.com, no card. |
| `GROQ_MODEL` | Hosted generation | Defaults to `openai/gpt-oss-120b`. |
| `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Local generation | Defaults suit a standard Ollama install. |
| `LLM_TIMEOUT_MS` | Slow local models | 120000. Raise it if your machine is slower. |
| `VOYAGE_API_KEY` | Embeddings | Secret. Free at console.voyageai.com, no card. |
| `VOYAGE_EMBEDDING_MODEL` | Embeddings | Defaults to `voyage-4-lite`. |
| `EMBEDDING_PROVIDER` | Embeddings | Defaults to `voyage`. Separate from `LLM_PROVIDER`. |
| `EMBEDDING_DIMENSIONS` | Embeddings | 256. Baked into the vector index; changing it means re-embedding. |
| `CHUNK_SIZE`, `CHUNK_OVERLAP` | Chunking | 1800 and 200 characters. |

`ENABLE_AI_TEST_ENDPOINT` used to be in this table. It kept `/api/ai/chat`
switched off in production because that route had no authentication. The route
now requires a signed-in user, so the flag is gone; a leftover line in your
`.env.local` is ignored.

### The one rule that matters

Anything prefixed `NEXT_PUBLIC_` is compiled into the JavaScript bundle and is
readable by anyone who opens the page. **Never put a secret behind that prefix.**

The project enforces this in three ways rather than trusting anyone to remember:

1. Public variables live in `src/lib/env.ts`; secrets live in
   `src/server/config/env.ts`.
2. Every file under `src/server/` starts with `import 'server-only'`, so a
   client component importing one fails the build.
3. An ESLint rule blocks imports from `src/server/` inside `src/lib/` and
   `src/components/`, with an error message explaining why.

---

## Deploying

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for GitHub and Vercel, including the
three variables that must differ between your laptop and production, why the
Atlas IP allowlist has to be opened to everywhere on a free plan, and what that
costs you.

---

## Run locally

```bash
npm run dev
```

Then open <http://localhost:3000>. The home page shows which subsystems are
wired up, and <http://localhost:3000/api/health> returns the same report as
JSON.

Logs are JSON, which is right for searching and unpleasant for reading. For
readable output while developing:

```bash
npm run dev:pretty
```

### Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run dev:pretty` | Same, with human-readable logs |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run check` | lint + typecheck + test. Run this before committing. |

Operational scripts, run directly rather than through npm because they act on
a real database and should not be one typo away from a build command:

| Command | Does |
| --- | --- |
| `npx tsx scripts/create-vector-index.ts` | Creates the Atlas vector index. Once per environment. |
| `npx tsx scripts/ingest-document.ts <file>` | Ingests one document into the shared knowledge base. |
| `npx tsx scripts/ingest-document.ts <file> --force` | Re-extracts and replaces its chunks. |

---

## Ollama, LLMs and providers

Four things get confused constantly, and the difference matters for every
decision in this project.

### Ollama is not the AI

**An LLM** is a file. Several gigabytes of numbers, learned during training,
that encode a function for predicting the next piece of text. On its own it
does nothing at all: it is data, not a program.

**Ollama** is the program that runs that file. It downloads models, loads them
into memory, and exposes an HTTP API on port 11434. It is a *runtime*, roughly
what Node.js is to a JavaScript file. Ollama has no intelligence of its own,
and swapping the model gives you completely different behaviour from the same
Ollama.

**A hosted provider such as Groq** is the same idea as Ollama, except the
machine is theirs. Their servers hold the model, run it on hardware you cannot
afford, and expose an HTTP API you reach over the internet with an API key.
Faster and much more capable; costs money past a free tier, and your text
leaves your machine.

**The application backend** is this Next.js app. It never runs a model. It
builds a request, sends it over HTTP, and shapes the answer. That is why it can
talk to Ollama or Groq without caring which.

```
                    your machine                    somebody else's machine
                 ---------------------              -----------------------
  browser  -->   Next.js backend      -->  HTTP -->  Ollama  -->  model file
                 (this app)                          (runtime)    (the "AI")

                 same backend         -->  HTTP -->  Groq API  -->  model
```

So "talking to an AI" is, in code, an ordinary `fetch` to a URL. That is the
whole trick, and it is why switching providers is configuration rather than a
rewrite.

### Why we start local

- **It is free and has no limits.** You will send hundreds of requests while
  building, and no free tier survives that.
- **Your documents never leave your machine.** That matters for a tool whose
  entire purpose is reading private files.
- **It works offline**, including on a plane.
- **You learn what the model actually contributes.** A local 1B model is weak
  enough that you can see the difference retrieval makes, which a very strong
  hosted model would paper over.

The honest trade: a 1B model on a CPU is slow and not very good. It will
sometimes ignore instructions. That is expected and it is useful, because it
makes the failure modes RAG exists to fix visible while you build.

### How this app talks to Ollama

Nothing outside one file knows Ollama exists.

```
  route handler  ->  getLLMProvider()  ->  registry  ->  Ollama provider
                     (reads config)        (lookup)      (the only file that
                                                          knows the HTTP shape)
```

`src/app/api/ai/chat/route.ts` asks for "the configured provider" and calls
`.complete()`. It never names a vendor. Adding Groq later is one new file plus
one line in `src/server/ai/providers/index.ts`; no route, component or service
changes.

The provider POSTs to `/api/chat` on the Ollama server and reads back the
answer plus token counts.

---

## Hosted providers (and why production needs one)

**Ollama runs on your machine.** A deployed app has no way to reach
`127.0.0.1:11434` on your laptop, so production needs a hosted provider. The
provider layer was built for exactly this: switching is one line in
`.env.local`, with no code change anywhere.

### One implementation, three vendors

Groq, OpenRouter and OpenAI all speak the same HTTP API. OpenAI defined
`POST /chat/completions` and it became the de facto standard, so the others
implemented it deliberately. The only differences are configuration:

| Vendor | Base URL | Example model |
| --- | --- | --- |
| Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

So `openai-compatible.ts` serves all three, and adding a fourth vendor that
speaks this dialect is a catalog entry rather than any code.

Ollama keeps its own file because it genuinely differs: no auth, a different
response shape, and options like `num_ctx` with no equivalent here.

### Recommended: Groq

This is the default. `LLM_PROVIDER` is `groq` unless you set it otherwise.

| | |
| --- | --- |
| Free tier | 30 requests/min, 1,000/day, 8,000 tokens/min, 200,000 tokens/day (checked September 2026) |
| Credit card | Not required |
| Speed | Several hundred tokens/sec, versus roughly ten on a CPU locally |
| **Data policy** | Groq does **not retain** customer data for inference by default. Zero data retention is available self-serve in Console → Data Controls |

That data policy is the reason Groq is the recommendation rather than the
fastest free tier generally. This app exists to read private documents, and
retrieved passages go into every prompt. A provider that trains on inputs
would be reading your documents too.

Google's Gemini free tier is more generous on context but its terms allow
using free-tier data to improve their products outside the EU/UK. Fine for
experiments, wrong for this.

**Every number in that table goes stale.** The live ones for your account are
at Console → Settings → Limits, and that page wins over this one.

### Set it up

1. Sign up at <https://console.groq.com> with Google or email.
2. **API Keys → Create API Key.** Copy it once; it is not shown again.
3. In `.env.local`:

   ```
   LLM_PROVIDER=groq
   GROQ_API_KEY=
   GROQ_MODEL=openai/gpt-oss-120b
   ```

4. Optional but recommended: Console → **Data Controls** → enable zero
   retention.

Then sign in and open `/ai-test`. Answers get noticeably better and faster
than a 1B model running on your CPU.

`openai/gpt-oss-20b` is the smaller, faster sibling if you want more headroom
inside the same daily limit.

### Model names expire, and the failure is confusing

Providers retire models on a published schedule. Groq shut down
`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` for free and developer
tiers on **16 August 2026**, which is why the default is now
`openai/gpt-oss-120b`. A retired model does not fail gently: you get a 404 that
looks like a broken endpoint.

So if `/ai-test` reports that the model was not found, check
<https://console.groq.com/docs/deprecations> before assuming the code is wrong.
Changing to a live model is one line in `.env.local`; the default lives in
`src/server/config/providers.ts`.

### A note on thinking models

`gpt-oss` models reason before they answer. The reasoning is returned in a
separate `message.reasoning` field, so the answer still arrives in
`message.content` and no parsing change was needed. But those reasoning tokens
count against `max_tokens`, which is why `LLM_MAX_OUTPUT_TOKENS` defaults to
2048 rather than something tighter. Set it too low and the model spends its
whole budget thinking and gets cut off mid-answer, which shows up as
`finishReason: "length"` with a short or empty response.

### Switching back to local

```
LLM_PROVIDER=ollama
```

That is the whole change. Local stays genuinely useful: free, offline, and
your documents never leave the machine.

### Honest limits of a free tier in production

1,000 requests a day is plenty for you, a demo, or a handful of users. It is
not a public product. The tighter constraint is 8,000 tokens per minute: one
request near the full context window uses most of a minute's budget on its
own. When you outgrow it, the same code takes a paid key with no change beyond
the value in `.env.local`.

Rate limiting surfaces as HTTP 429 with a message saying so, rather than a
generic failure, because on a free tier it is expected behaviour rather than a
bug.

---

## Embeddings

### What an embedding is

A model that turns text into a list of numbers. Nothing else.

The clearest way to see it is colour. A colour on your screen is an embedding
with three dimensions, red green blue:

```
red      = [255,   0,   0]
crimson  = [220,  20,  60]      similar numbers, similar colour
blue     = [  0,   0, 255]      far away
```

Three things fall out of that, and they are the whole idea:

- Similar things get similar numbers
- You can **measure** similarity with arithmetic, no understanding required
- Every colour becomes exactly three numbers, whatever the colour

A text embedding is the same, with 256 axes instead of 3, where the axes
represent shades of meaning rather than shades of colour:

```
"how do I cancel my order"      = [0.21, -0.88, 0.13, ...]
"I want to return this item"    = [0.19, -0.85, 0.15, ...]   close by
"what is the capital of France" = [-0.67, 0.42, -0.91, ...]  far away
```

Search stops being "which document contains these words" and becomes "which
stored numbers are nearest to my question's numbers". That is why retrieval
finds the right paragraph even when it shares no vocabulary with the question.

### Voyage embeds. Groq answers. Neither can do the other's job.

This is the single most common point of confusion, so it is worth being blunt.

| | **Groq** | **Voyage** |
| --- | --- | --- |
| Model | `openai/gpt-oss-120b` | `voyage-4-lite` |
| Input | Text | Text |
| Output | **Sentences** | **Numbers** |
| Job | Writes the answer | Makes search possible |
| Size | 120 billion parameters | Small, cheap, fast |
| Can it write? | Yes | **No** |
| Can it embed? | **No** | Yes |

Groq publishes no embedding model. Voyage publishes no chat model. They are
different companies making different kinds of model, which is why they have
separate settings and separate keys.

The provider catalog records this, so pointing `LLM_PROVIDER` at Voyage fails
at configuration time with a clear message rather than at the first request
with a 404:

```ts
voyage: { capabilities: { chat: false, embeddings: true, streaming: false } }
groq:   { capabilities: { chat: true,  embeddings: false, streaming: true } }
```

### Why Voyage

Four reasons, in order of how much they mattered:

- **A large free token allowance with no card required.** Enough that a
  learning project will not approach it.
- **Output dimensions reducible to 256.** The one that decided it. See below.
- **Owned by MongoDB**, which is where the vectors are going.
- **32,000 token input**, so a chunk never has to be split to fit.

Gemini scores better on public benchmarks and is also free. It was rejected
because its free tier uses inputs to improve Google's products, and this
application exists to read private documents. Once retrieval works, every
request carries chunks of whatever you uploaded.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `VOYAGE_API_KEY` | **Secret.** Server-side only, never bundled. |
| `VOYAGE_EMBEDDING_MODEL` | Defaults to `voyage-4-lite`. |
| `EMBEDDING_PROVIDER` | `voyage`. Separate from `LLM_PROVIDER`. |
| `EMBEDDING_DIMENSIONS` | `256`. Baked into the vector index. |
| `EMBEDDING_MODEL` | Generic override. Usually unset. |
| `CHUNK_SIZE` | `1800` characters. |
| `CHUNK_OVERLAP` | `200` characters. |

The Groq key is never used for embeddings and the Voyage key is never used for
generation. There is deliberately no fallback between them: sending one to the
other produces a 401 that reads like a bad key rather than crossed wiring.

### Why 256 dimensions

More dimensions means more room to record distinctions, so in theory better
search. The gain is real and modest. The cost is not:

```
1024 dimensions  =  4 KB per chunk   →  ~130,000 chunks fills an M0 cluster
 256 dimensions  =  1 KB per chunk   →  four times the corpus
```

Your Atlas free tier is 512 MB **total**, shared between vectors, document
text and indexes. Voyage's v4 models are trained so the most important
information sits in the earliest numbers, which means truncating costs less
accuracy than the fourfold reduction suggests.

**This is the least reversible setting in the project.** The dimension is
declared on the vector index and every stored vector must match it. Changing
it means a new index and re-embedding every document ever uploaded, because a
256-number question cannot be compared against 1024-number passages. Different
spaces, not different scales.

Voyage v4 accepts 256, 512, 1024 or 2048. Anything else is rejected, and the
embedding service checks at configuration time rather than on first upload.

### How a document flows through

```
document
   ↓  text extraction        unpdf (pdf.js), per page
   ↓  cleaning               cleanText:  normalise whitespace, keep paragraphs
   ↓  chunking               chunkText:  1800 chars, 200 overlap
   ↓  Voyage embedding       input_type: "document"
   ↓  MongoDB                chunk + vector + userId + embeddingModel
```

And at query time:

```
question
   ↓  Voyage embedding       input_type: "query"
   ↓  Atlas $vectorSearch    filtered by userId INSIDE the search
   ↓  relevant chunks
   ↓  Groq                   writes the answer from those chunks
```

Note `input_type`. Voyage prepends its own instruction depending on whether it
is embedding something being **stored** or something being **asked**, which
produces vectors tuned for retrieval. Getting it backwards does not error, it
just quietly makes search worse. That is why the interface has separate
`embedDocuments` and `embedQuery` methods rather than one `embed` and a flag
somebody forgets to set.

### Chunking, and why the numbers are what they are

A document cannot be embedded whole. Two hard limits:

- The embedding model produces **one vector per input**. Embed fifty pages and
  you get a single point that is the average of everything, which is near
  nothing in particular.
- The answering model has a fixed context window. Fifty pages does not fit in
  8192 tokens alongside the question and the answer.

So it is cut into passages, and the passage becomes the unit that gets
embedded, retrieved and cited. Chunking quality sets a ceiling on retrieval
quality that no model choice can lift.

**1800 characters, roughly 450 tokens.** Retrieval fetches about five
passages. Five at 450 tokens is ~2250, which fits inside 8192 with room for
the question, instructions and answer.

**200 characters of overlap, about 11 percent.** Without it, a sentence
straddling a boundary is cut in half and neither half retrieves well.

The chunker cuts at a paragraph break where it can, then a sentence ending,
then a line break, then a space. Mid-word is the last resort. It also absorbs
a short final chunk rather than leaving a 100-character orphan that embeds
badly and cites poorly.

Both numbers are environment variables because there is no correct answer,
only one that suits a corpus. Smaller chunks match sharply but lose context;
larger ones keep context but dilute the match.

### MongoDB Vector Search

The vector index is **not** created by `ensureIndexes`. Atlas Search indexes
use a separate API and build asynchronously.

```bash
npx tsx scripts/create-vector-index.ts
```

Safe to run repeatedly. If the cluster does not allow programmatic creation,
it prints the exact JSON for the Atlas UI. The definition:

```json
{
  "name": "chunk_embedding_vector_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 256, "similarity": "cosine" },
      { "type": "filter", "path": "userId" },
      { "type": "filter", "path": "documentId" }
    ]
  }
}
```

**`userId` as a filter field is the security boundary, not an optimisation.**

Vector search returns the N nearest vectors. Without a filter inside the
search, the only way to enforce ownership is to fetch the global top matches
and discard other people's afterwards. That fails twice over:

1. It **silently returns fewer results than asked for**. Request 5, get the
   global top 5, discard 4 belonging to other users, answer from 1. Retrieval
   quality collapses and nothing reports an error.
2. One missed filter and another user's document text reaches a prompt, and
   from there an answer.

Declared as a filter, Atlas restricts the search space before finding nearest
neighbours. You get the top 5 **of that user's chunks**, which is both correct
and better.

**Cosine similarity** because it compares direction and ignores magnitude, so
a long passage and a short one about the same subject score as similar.
Euclidean distance would call them far apart purely because one vector is
bigger. For text, meaning is direction.

### User isolation

Every chunk stores `userId` even though it could be derived from its parent
document. That is not redundancy: a vector search filter can only reference a
field on the row being searched, so deriving ownership would make the filter
impossible and force it to run after ranking.

The ownership rules, all of which have tests against a real MongoDB:

- The user id comes from the **session, server-side**. A client-supplied
  `userId` is never trusted to determine ownership.
- Every id goes through `toObjectId`, so a body of `{"userId": {"$ne": null}}`
  is rejected rather than matching every row in the collection.
- Repository functions take `userId` and filter on it. There is no
  `findChunkById`, only `listChunksForDocument(documentId, userId)`.
- Another user's data returns empty rather than throwing. A distinguishable
  error would confirm the row exists.

### Never mix models in one index

Two embedding models produce coordinates in unrelated spaces. Vectors from
model A and model B can be the same length and still mean nothing to each
other, so comparing them returns a number that looks like a similarity score
and is noise. Nothing errors. Search just quietly returns nonsense.

Which is why `embeddingModel` is stored on every chunk. It is what makes a
model change detectable and migratable rather than silently corrupting.

---

## Retrieval, and asking the document a question

`/chat` is where the application does what it was built to do. `/ai-test` is
the same model with the middle removed, kept deliberately so the two can be
compared:

```
/ai-test   question ------------------------------> Groq -> answer
/chat      question -> embed -> search -> passages -> Groq -> answer
```

Ask both the same question about your document. `/ai-test` will produce a
confident, fluent, entirely invented answer, because the model has never seen
the file. Those three extra steps are the whole difference.

### The instruction that does the real work

Retrieval alone does not stop invention. It puts the right text in front of the
model; something still has to tell the model that the text is the only thing it
may use. That is `src/server/rag/prompts.ts`, and the load-bearing lines are:

> Use only the information in the passages below. Do not use anything you know
> from training.
>
> If the passages do not contain the answer, say exactly that you could not
> find it in the document. Do not guess.

When nothing matches, **the model is not called at all.** Asking it to answer
from zero passages would spend a request to produce exactly the failure this
application exists to prevent, and an empty corpus is the state every new
deployment starts in.

### Every answer shows its passages

The response carries the passages the model was given, and `/chat` renders them
under the answer. This is not a nicety. An answer without its sources is an
answer whose mistakes are undetectable, and the mistakes are the reason all
this machinery exists.

Each one shows its similarity score. Roughly: above 0.75 is a strong match,
0.6 to 0.75 is related, below that is probably noise. Five passages all scoring
around 0.4 means the document does not cover the question, whatever the answer
says.

### Prompt injection

The passages come out of a document, and a document can contain any words at
all, including "ignore your previous instructions". Once that text is in a
prompt, a model sees no difference between an instruction we wrote and one that
arrived inside a PDF.

Each passage is fenced, and the system prompt states that anything between
fences is quoted material rather than a command. That is the standard
mitigation and it is not airtight; nothing purely prompt-based is. What limits
the damage here is that there is little to steal: no tools, no function calling,
no ability to send mail or write to the database, and the answer goes back to
the person who asked. Proper hardening belongs with the security phase.

### The context budget

A model's context window is one allowance shared by the instructions, the
passages, the question and the answer it has yet to write. The answer's share
is what gets squeezed, because it is the only part not yet on the page.

Send five unusually long passages and the model has room for two sentences. It
does not error; it stops mid-sentence and `finishReason` comes back as
`length`. So passages are added in rank order until a ceiling is reached and
the rest are dropped. Losing the fifth-best passage is a small cost. A
truncated answer is a visible failure.

### Environment variables

| Variable | Used for |
| --- | --- |
| `RETRIEVAL_TOP_K` | `5`. How many passages a question retrieves. |
| `RETRIEVAL_CONTEXT_SHARE` | `0.5`. Share of the context window passages may occupy. |

Too few passages and the answer misses something the document says, because the
passage covering it ranked sixth. Too many and the useful one is diluted, the
model has more room to wander, and every question costs more of the window.

### When search is unavailable

Atlas builds search indexes asynchronously, so a freshly created one is
genuinely absent for a while, and a typo in its name looks identical. Both
produce:

> Document search is not available right now. The search index is missing,
> still building, or this database does not support vector search.

Check the index at Atlas, Search and Vector Search. You want
`chunk_embedding_vector_index` showing **READY**, **Queryable**, and 100% of
documents indexed. Anything less than 100% usually means stored vectors do not
match the length the index was built for.

---

## Document ingestion

### One shared knowledge base. Nobody uploads anything.

This version answers questions about **one company document**, curated by
whoever runs the project. A signed-in user asks questions. There is no upload
button, no upload page and no upload endpoint, for anybody.

That is the product decision, and it is also the security model:

- Ingestion runs from a **terminal script**, not an HTTP route.
- Authorization is **possession of the server's credentials**. Not a role, not
  a session, not a permission check.
- There is no endpoint to find, no session to forge, and no bug in a permission
  check to exploit, because none of those things exist.

A role system guarding an admin route would be more code doing a weaker job. If
per-user uploads are wanted later, that is the point to add roles and a route
deliberately, and `tests/unit/ingestion-surface.test.ts` fails the moment
ingestion becomes reachable over HTTP, so the decision cannot be made by
accident.

Shared documents are stored under a fixed owner id,
`KNOWLEDGE_BASE_OWNER_ID`, rather than being ownerless. That keeps every query
filtering on one `userId` field. When per-user documents arrive, the retrieval
filter becomes:

```js
{ userId: { $in: [theSignedInUser, KNOWLEDGE_BASE_OWNER_ID] } }
```

One field, one operator. The alternative, an `$or` across `userId` and a
nullable `isShared`, is where ownership bugs live.

### Supported formats

| Format | Notes |
| --- | --- |
| `.pdf` | Text-based only. See the scanned-PDF note below. |
| `.md` | Markdown |
| `.txt` | Plain text |

**A scanned PDF is rejected, on purpose.** A scan is a stack of photographs. It
opens, it has the right number of pages, it looks completely normal, and it
contains zero extractable characters. Allowed through, it becomes a document
marked `ready` with no chunks, and months later a chat feature that answers
"I could not find that in your documents" about a file sitting right there in
the list. Nothing in the logs would explain why.

So an empty extraction fails immediately with a message naming the likely
cause. OCR is a later phase.

### Provide the document

Put the file anywhere on the machine running the script. Nothing is uploaded
and nothing is copied into the repository.

```bash
mkdir -p docs
# then put your PDF in ./docs/
```

`docs/` is git-ignored. A company document is not repository content, and a
PDF committed once stays in the history after it is deleted.

### Run it

The vector index has to exist first, and only needs creating once per
environment:

```bash
npx tsx scripts/create-vector-index.ts
npx tsx scripts/ingest-document.ts ./docs/company-handbook.pdf
```

Output:

```
Ingesting into the shared knowledge base
  file        company-handbook.pdf
  type        application/pdf
  size        842.1 KB
  provider    voyage
  model       voyage-4-lite
  dimensions  256
  chunk size  1800 chars, 200 overlap
  force       false

Ingestion complete.
  documentId  6a1f...c33
  characters  128204
  pages       46
  chunks      79
  took        4.2s
```

**Re-running the same file does nothing.** The document is identified by a
SHA-256 hash of its contents, so a second run is recognised and skipped rather
than quietly doubling the corpus, which would return the same passage twice for
every question.

To re-extract and replace its chunks, which is what you want after changing
`CHUNK_SIZE` or the embedding model:

```bash
npx tsx scripts/ingest-document.ts ./docs/company-handbook.pdf --force
```

The script reads `.env.local` the same way `next dev` does. It needs
`MONGODB_URI` and `VOYAGE_API_KEY` and nothing else.

### It will take a few minutes, and that is the rate limit

Voyage's **free trial allows 3 requests and 10,000 tokens per minute** until a
payment method is added. Tier 1 with one is 2,000 requests and 16,000,000
tokens, which is three orders of magnitude more room.

That ceiling changes the shape of the problem rather than just the numbers.
10,000 tokens a minute is about 22 passages, so a sixty-page PDF **cannot be
embedded in one request at any batch size**, and retrying does not help: the
request itself is over the limit. So ingestion does three things:

1. **Batches by estimated tokens, not by passage count.** Counting passages was
   the original bug. Forty-nine chunks of a real document came to roughly
   17,000 tokens in a single request, which Voyage refused on arrival, every
   time.
2. **Paces itself to both published limits**, waiting the longer of the two
   gaps they imply. Pacing on requests alone is not enough, and the failure is
   not subtle: three requests a minute at 8,000 tokens each honours the request
   rate perfectly and breaches a 10,000-token minute twice over.
3. **Retries a 429**, honouring `Retry-After` when the server sends it. On a
   free tier a rate limit is an ordinary event, not an exceptional one, so
   waiting it out is the normal path rather than error handling.

The script says up front how long it expects to wait:

```
Embedding 62 passages in 4 requests, paced to 3 requests and
10000 tokens per minute (about 139s of waiting)
```

Once you add a payment method, two lines in `.env.local` remove the wait
entirely:

```dotenv
EMBEDDING_REQUESTS_PER_MINUTE=2000
EMBEDDING_TOKENS_PER_MINUTE=16000000
```

### Environment variables

Ingestion uses what embedding already needed, plus four settings for the rate
limit:

| Variable | Used for |
| --- | --- |
| `MONGODB_URI` | **Secret.** Where documents and chunks are stored. |
| `VOYAGE_API_KEY` | **Secret.** Server-side only, never bundled. |
| `EMBEDDING_DIMENSIONS` | Must match the vector index. Changing it means re-ingesting. |
| `CHUNK_SIZE` | `1800` characters. |
| `CHUNK_OVERLAP` | `200` characters. |
| `EMBEDDING_MAX_TOKENS_PER_REQUEST` | `8000`. Below the per-minute ceiling on purpose. |
| `EMBEDDING_REQUESTS_PER_MINUTE` | `3`. From the vendor's limits page. |
| `EMBEDDING_TOKENS_PER_MINUTE` | `10000`. From the same page. |
| `EMBEDDING_MAX_RETRIES` | `4`. Retries for a rate-limited request. |

### Check what happened

Every run leaves a row you can read. In Atlas, open **Browse Collections**.

`documents` — one row, and the field to look at is `status`:

| `status` | Meaning |
| --- | --- |
| `ready` | Done. `chunkCount` is how many passages are searchable. |
| `failed` | Read `error.safeMessage` on the same row. |
| `extracting` / `chunking` / `embedding` | Still running, or the process was killed mid-run. Re-run with `--force`. |

`document_chunks` — one row per passage. A healthy row has:

- `embedding`: an array of exactly 256 numbers
- `embeddingModel`: `voyage-4-lite`
- `scope`: `shared`
- `sourceName`: the original filename, so a citation can name it
- `pageNumber`: present for PDFs, absent for `.md` and `.txt`

Counting from the shell instead:

```js
db.documents.find({}, { originalName: 1, status: 1, chunkCount: 1 })
db.document_chunks.countDocuments({ documentId: ObjectId("...") })
```

`chunkCount` on the document and the real count in `document_chunks` should
match. They are written in that order for exactly this reason: the count is set
last, only after every chunk is on disk.

### A document is never half-ingested

MongoDB has no transaction spanning "call an external API forty times, then
write four hundred rows", and reaching for one would be the wrong tool. What
matters is not that the write is atomic. It is that **the status never lies**.

So the order is deliberate:

1. Embed everything first, in memory. Nothing is written yet.
2. Only once every vector exists, delete the old chunks and insert the new ones.
3. Only once every chunk is stored does the document become `ready`.

If embedding fails at chunk 70 of 100, no chunks were written at all and the
document is marked `failed` with a reason. The corpus is never left holding a
partially embedded document that looks complete and answers questions from two
thirds of a file.

The cost is holding the vectors in memory before writing, which for one company
document is a few megabytes.

### When it fails

| What the script prints | Cause |
| --- | --- |
| `No extractable text found. The PDF appears to be scanned...` | Images of text, not text. Needs OCR, which is a later phase. |
| `The PDF could not be read. It may be corrupt, or protected with a password.` | Exactly that. |
| `Unsupported file type` | Not `.pdf`, `.md` or `.txt`. Printed before anything is read. |
| `VOYAGE_API_KEY is required for the "voyage" provider.` | Not set in `.env.local`. |
| `The embedding service rejected our credentials.` | Key is set but wrong or revoked. |
| `Embedding rate limit reached. Wait a moment and try again.` | Voyage rate limit. Re-run with `--force`. |
| `The embedding service reports no remaining credit.` | Free tier exhausted. |
| `...dimensions, but the vector index expects...` | `EMBEDDING_DIMENSIONS` no longer matches the index. Recreate the index, then re-ingest with `--force`. |

Nothing printed by the script contains a key, a connection string or the
contents of the document. The failure path deliberately prints no stack trace,
because driver and parser errors carry both connection strings and fragments of
document text, and this runs in terminals and CI logs.

---

## Set up Ollama

### 1. Install

Download the installer from <https://ollama.com/download>. On Windows it starts
automatically after install and keeps running in the background.

Check it worked:

```powershell
ollama --version
```

### 2. See what models you have

```powershell
ollama list
```

A fresh install lists nothing. Models are separate downloads.

### 3. Pull a model

```powershell
ollama pull llama3.2:1b
```

**Why this one, on an 8 GB machine with no discrete GPU.** After Windows,
a browser, an editor and the dev server, you have roughly 1 to 1.5 GB of
headroom. `llama3.2:1b` is about 1.3 GB and fits. `llama3.2:3b` is about 2 GB
and will page to disk and crawl. Anything 7B or larger needs memory you do not
have.

It is not a strong model. It is a model that runs, which is what this phase
needs.

### 4. Point the app at it

In `.env.local`:

```
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:1b
```

`127.0.0.1` rather than `localhost`: on some Windows setups `localhost`
resolves to IPv6 first and the connection is refused.

**Model resolution order** is `LLM_MODEL`, then `<PROVIDER>_MODEL`, then a
built-in default per provider. Model names are not portable, so each provider
gets its own variable and switching `LLM_PROVIDER` does not leave a model name
behind that the new provider has never heard of.

### 5. Test it

Start the app and open <http://localhost:3000/ai-test>. The page reports
whether Ollama is reachable and whether your configured model is installed
before you send anything.

Or from the terminal:

```powershell
curl.exe -X POST http://localhost:3000/api/ai/chat -H "content-type: application/json" -d "{\"message\":\"What is a vector database?\"}"
```

**The first request is slow.** Measured on this project: 13 seconds cold,
0.5 seconds warm. Almost all of the cold time is Ollama loading the model into
memory, not generating. It stays loaded for a few minutes after use.

### When something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `LLM_UNAVAILABLE` | Ollama is not running | `ollama serve`, or open the Ollama app |
| `LLM_MODEL_NOT_FOUND` | Model not downloaded | `ollama pull llama3.2:1b` |
| `LLM_TIMEOUT` | Model too slow or too large for your RAM | Use a smaller model, or raise `LLM_TIMEOUT_MS` |
| First call takes 15s | Model loading into memory | Expected. The next one is fast. |

---

## Authentication

### How Google sign-in works here

```
  1. click       browser  ->  our server  ->  redirect to Google
  2. login       user authenticates WITH GOOGLE (we never see the password)
  3. callback    Google   ->  /api/auth/callback/google  with a short-lived code
  4. exchange    our SERVER trades that code for tokens using the client secret
                 (server to server: the secret never touches the browser)
  5. persist     Auth.js upserts users + accounts, inserts a sessions row
  6. cookie      httpOnly session cookie set on the browser
  7. every       cookie -> sessions row -> user id
     request
```

The cookie holds a **session ID, not your identity**. There is nothing in it a
user could edit to become somebody else, which is the difference between this
and putting a user id in a cookie.

### Database sessions, not JWT

A JWT session is self-contained, so the server verifies it without a database
lookup. Faster, and it **cannot be revoked**: signing out deletes the cookie,
but the token stays valid until it expires, so a copied one keeps working.

This app holds private documents, so signing out has to mean something. The
session is a database row and signing out deletes it. The extra lookup is free
in practice because these requests hit MongoDB anyway.

### What gets stored, and what deliberately does not

| Collection | Holds |
| --- | --- |
| `users` | name, email, image, emailVerified, createdAt, updatedAt |
| `accounts` | the Google provider id and account id |
| `sessions` | session token, user id, expiry |

**No password, ever.** OAuth means Google authenticates the user and we never
see a credential.

**No OAuth tokens either.** By default the adapter stores Google's
`access_token`, `refresh_token` and `id_token`, which exist so an app can call
Google APIs on the user's behalf later. This app never does that: it needs to
know who you are once, at sign-in. So those three fields are stripped before
the row is written. The reasoning is blast radius, since a stored refresh token
is a long-lived key to somebody's Google account, and data you never store
cannot leak.

### Three layers of protection

| Layer | Where | Catches |
| --- | --- | --- |
| 1. Middleware | `src/middleware.ts` | Unauthenticated visitors, with a fast redirect |
| 2. `requireUser()` | Every protected page and route | Forged, expired or invalid sessions |
| 3. Repository layer | Every database query | One user reaching another's data |

**Layer 1 is not a security boundary, and that is deliberate.** Middleware runs
on the Edge runtime, which has no MongoDB driver, so it can see that a session
cookie *exists* but not that it is *valid*. It is a user-experience
optimization. Verified: a request carrying `authjs.session-token=totally-made-up`
gets past middleware and is then bounced by `requireUser()`.

Treating middleware as the security boundary is a common and serious mistake.

### Why the user id matters so much

`requireUser()` is the only place server code learns who is asking. It reads
the session cookie server-side and never trusts a user id from a request body,
query string or header, because all three are attacker-controlled.

Everything downstream depends on that value being right:

- every document belongs to a user
- every chunk belongs to a user and a document
- the vector search will filter on `userId` **inside** the search, so one
  person's passages cannot reach another person's prompt

If you ever find a user id being read from anywhere else, that is the bug.

### The chat endpoint, and why it is behind a session

`POST /api/ai/chat` is the first route that spends money on someone's behalf,
and its first line is now `await requireUser()`. Not the second line, and not
after the body is parsed:

```ts
export const POST = createRoute('ai.chat', async (request) => {
  const user = await requireUser();   // <- before anything else
  ...
});
```

The ordering is the point. An anonymous caller should not be able to make the
server parse a body, validate a schema, or open a connection to a paid API.
Checking the session first means a request without one costs a cookie lookup
and nothing more.

This replaced a feature flag. Before authentication existed, the route was kept
off in production by `ENABLE_AI_TEST_ENDPOINT`, which is a hidden door rather
than a lock: anyone who knew the path could open it the moment the flag was
switched on for a demo and forgotten. The flag is gone.

| Request | Answer |
| --- | --- |
| No session | `401` `UNAUTHORIZED`, "You need to sign in to do that." |
| Session, empty or oversized message | `400` `VALIDATION_ERROR` |
| Session, valid message | `200` with the answer, token counts and duration |
| Provider rate limit hit | `429`, saying so plainly |
| `GROQ_API_KEY` not set | `500`, generic to the caller, specific in the logs |

The same rule covers `/ai-test`, which is a Server Component that resolves the
session before it renders anything, exactly like `/dashboard` does.

**One log line per completion**, and it records `userId`, provider, model,
prompt and completion tokens, finish reason and duration. It does not record
the question or the answer. Those are the user's, and a log is not where they
belong; there is a test asserting the route never hands them to the logger in
the first place, rather than relying on redaction to catch them afterwards.

The last row of that table is worth dwelling on. The caller is told "The server
is not configured correctly." and nothing else, while the log line names
`GROQ_API_KEY`. Telling a caller which variable is missing maps your
deployment's configuration for free, and they cannot fix it anyway. The person
who can fix it reads the logs.

---

## Set up Google OAuth

1. **Create a project** at <https://console.cloud.google.com>.
2. **Configure the consent screen.** APIs & Services > OAuth consent screen.
   External is fine. Add yourself as a test user while it is unpublished.
3. **Create credentials.** APIs & Services > Credentials > Create Credentials >
   OAuth client ID > **Web application**.
4. **Add the redirect URI**, exactly:

   ```
   http://localhost:3000/api/auth/callback/google
   ```

   It must match character for character, including the scheme and port.
   A mismatch produces `redirect_uri_mismatch`, which is the single most common
   setup failure.

5. **Put the values in `.env.local`:**

   ```
   GOOGLE_CLIENT_ID=
   GOOGLE_CLIENT_SECRET=
   AUTH_SECRET=
   ```

   Generate the secret:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   `AUTH_SECRET` signs the session cookie. Changing it invalidates every
   existing session, which is also how you force everyone to sign in again.

### Test the login

1. `npm run dev`
2. Open <http://localhost:3000/dashboard>. You should be redirected to
   `/login?callbackUrl=%2Fdashboard`.
3. Click **Continue with Google** and pick your account.
4. You land on `/dashboard` with your name, email and picture.
5. Open <http://localhost:3000/api/auth/me> for your session as JSON.
6. Click **Sign out**, then try `/dashboard` again: redirected. Check that
   `/api/auth/me` now returns 401.

### When something goes wrong

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | The URI in Google Cloud Console does not match exactly |
| `Configuration` on the login page | `AUTH_SECRET`, `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` missing |
| Signed in but bounced back | Database unreachable, so the session row cannot be written. Check `/api/health/db` |
| `AccessDenied` | Your Google account is not on the consent screen's test-user list |

### Security notes on `.env.local`

- `.gitignore` covers `.env` and `.env.*` while allowing `.env.example`, so a
  filled-in file cannot be committed by accident.
- `.env.local` is the **only** place real values belong. Not in source, not in
  a README, not in a chat message, not in a screenshot.
- `GOOGLE_CLIENT_SECRET` and `AUTH_SECRET` are read only in server code guarded
  by the `server-only` package, so importing them from a client component fails
  the build rather than shipping them to the browser.
- If a credential is ever exposed, rotate it. Google Cloud Console lets you add
  a second client secret and delete the old one with no downtime.

---

## Database architecture

Five collections. Everything a user owns traces back to a `users._id`, and that
id is the tenant key for the whole application.

```
users
  |
  |-- documents            (userId)
  |     |
  |     `-- document_chunks (userId, documentId)
  |
  `-- conversations        (userId)
        |
        `-- messages       (userId, conversationId)
```

### users

**What it is.** A person who signed in.

**Why.** The root of every ownership chain. Without it there is no way to say
whose document a document is.

**Fields now.** `email` (unique), `name`, `image`, `emailVerified`, timestamps.

**Later.** Auth.js takes over writing these rows next phase through its MongoDB
adapter, and adds `accounts` and `sessions` alongside. The shape here is
deliberately compatible so the two do not fight. Storage and query quotas get
added when uploads exist.

### documents

**What it is.** An uploaded file and how far its processing got.

**Why.** Ingestion cannot finish inside one request: a large PDF has to be
extracted, split and embedded, and each of those can take longer than a request
may run. The row records where it reached, so work is resumable.

**Fields now.** `userId`, `originalName`, `mimeType`, `sizeBytes`, `checksum`,
`status`, `error`, `chunkCount`, timestamps, `deletedAt`.

**Status flow.** `uploaded -> extracting -> extracted -> chunking -> chunked ->
embedding -> ready`, with `failed` reachable from any step.

**Later.** `storageKey` when file storage lands, `pageCount` and `progress` with
real ingestion, `embeddingModel` with embeddings.

**Relationship.** Belongs to one user. Never shared.

### document_chunks

**What it is.** One searchable passage of a document.

**Why.** A whole document is too long to embed usefully or to fit in a prompt.
It gets split into overlapping passages, and the passage is the unit that is
embedded, retrieved and cited. This becomes the largest collection by a wide
margin.

**Fields now.** `userId`, `documentId`, `chunkIndex`, `content`, `tokenCount`.

**Later.** `embedding` (the 768-number vector) in the embeddings phase, and
`pageNumber` plus `headingPath` when citations need to point at a place.

**Relationship.** Belongs to one document and one user. `userId` is stored here
even though it could be derived from the parent, and that is not just about
avoiding a join: the Atlas vector index will declare `userId` as a filter field
so a search can be constrained to one user's chunks inside the search itself.
Adding it later would mean backfilling the biggest collection in the app.

### conversations

**What it is.** A chat thread.

**Why.** Groups messages so a user can return to an earlier line of
questioning, and so a follow-up question has history to resolve against.

**Fields now.** `userId`, `title`, `messageCount`, `lastMessageAt`, timestamps,
`deletedAt`.

**Later.** `documentIds` to scope a thread to particular documents, and
`summary` for condensing long threads within the token budget.

**Relationship.** Belongs to one user.

### messages

**What it is.** One turn in a conversation.

**Why.** A separate collection rather than an array on the conversation, for
two reasons: a MongoDB document is capped at 16 MB and a long thread would
approach it, and messages need pagination rather than loading whole.

**Fields now.** `userId`, `conversationId`, `role` (`user` or `assistant`),
`content`, `createdAt`.

**Later.** `citations` and retrieval telemetry when RAG produces answers.

**Relationship.** Belongs to one conversation and one user. Both ids are on the
row so an ownership check is one indexed lookup rather than a join.

### Indexes

| Collection | Index | Serves |
| --- | --- | --- |
| users | `email` unique | One account per address; Auth.js relies on it |
| documents | `userId, createdAt desc` | The document list |
| documents | `userId, status` | Finding work still to process |
| documents | `userId, checksum` unique, partial on `deletedAt: null` | Per-user deduplication that survives a delete and re-upload |
| document_chunks | `documentId, chunkIndex` unique | Reading chunks in order |
| document_chunks | `userId` | Per-user counts and cleanup |
| conversations | `userId, lastMessageAt desc` | The conversation sidebar |
| messages | `conversationId, createdAt` | Reading a thread in order |
| messages | `userId, createdAt desc` | Ownership checks without a join |

Nearly every index starts with `userId`, because every query for owned data
filters on it and a compound index can serve a query on its prefix. The reverse
is not true: getting the order wrong means collection scans that grow with
every signup.

The **vector search index is not here.** It is a different kind of index,
created through a separate Atlas API, and it arrives with the embeddings phase
in its own script.

### The rule the whole layer exists to enforce

There is no `findDocumentById(id)` in this codebase. There is only
`findDocumentForUser(id, userId)`.

Authorization checks written in route handlers get forgotten eventually, in the
fourteenth handler someone adds in a hurry. Making `userId` a required
parameter of the data layer means the check cannot be forgotten: the code does
not compile without it.

Records belonging to another user read as absent (`null`, `[]`, `0`, `false`),
never as an error. A distinguishable response would confirm the id exists,
which is enough to enumerate someone else's records.

`tests/integration/repositories.test.ts` has a `cross-user isolation` suite
where a second user attempts to reach every one of the first user's records
through every function. It must keep passing.

---

## Project structure

Folders for future phases exist and contain a README explaining what will live
there and when. They are empty on purpose: the shape of the project is visible
from the start, and nothing is imported before it exists.

```
ai-document-assistant/
├── .env.example              Documented template. The only env file committed.
├── eslint.config.mjs         Includes the client/server import boundary rule
├── next.config.ts            Security headers, strict build
├── vitest.config.ts
├── docs/                     Source documents for ingestion. Git-ignored.
├── scripts/
│   ├── bootstrap.ts          Loads .env.local and stubs server-only for tsx
│   ├── create-vector-index.ts  The Atlas vector index. Once per environment.
│   └── ingest-document.ts    The ONLY way a document enters the corpus
├── src/
│   ├── app/
│   │   ├── page.tsx          Home page and status dashboard
│   │   ├── layout.tsx
│   │   ├── globals.css       Tailwind import and design tokens
│   │   └── api/health/       GET /api/health
│   ├── components/
│   │   ├── ai/chat-tester.tsx  Client component for the test page
│   │   └── auth/               Sign-in and sign-out buttons
│   ├── lib/                  Isomorphic. Bundled for the browser.
│   │   ├── constants.ts
│   │   ├── env.ts            PUBLIC env only. No secrets, ever.
│   │   └── schemas/          Shared Zod schemas                   [phase 3+]
│   ├── server/               Server-only. Never reaches the browser.
│   │   ├── ai/
│   │   │   ├── types.ts      LLMProvider and EmbeddingProvider interfaces
│   │   │   ├── registry.ts   Register and resolve providers
│   │   │   ├── factory.ts    Environment to provider instance
│   │   │   ├── providers/
│   │   │   │   ├── ollama.ts The only file that knows Ollama's HTTP shape
│   │   │   │   └── index.ts  Where a vendor is connected to the registry
│   │   ├── auth/
│   │   │   ├── config.ts     Auth.js config, built per request not at import
│   │   │   ├── index.ts      auth / handlers / signIn / signOut
│   │   │   ├── mongo-adapter.ts  Adapter wrapper: timestamps, token stripping
│   │   │   └── require-user.ts   The ONLY source of a user id
│   │   ├── config/
│   │   │   ├── env.schema.ts Zod schema, no side effects
│   │   │   ├── env.ts        Reads process.env, memoized
│   │   │   └── providers.ts  The provider catalog
│   │   ├── db/
│   │   │   ├── client.ts     Cached MongoClient, one pool per process
│   │   │   ├── collections.ts Typed accessors; names live here only
│   │   │   ├── types.ts      Entity interfaces, NOT the API's types
│   │   │   ├── schemas.ts    Zod validation for writes
│   │   │   ├── indexes.ts    Index definitions, idempotent creation
│   │   │   ├── ids.ts        Untrusted id parsing, blocks operator injection
│   │   │   ├── redact.ts     Strips credentials from driver errors
│   │   │   └── repositories/ userId required on every owned-data function
│   │   ├── health/report.ts  Shared by the API route and home page
│   │   ├── http/route.ts     The wrapper every API route uses
│   │   ├── ingestion/        Empty. Merged into rag/; its README says why.
│   │   ├── observability/
│   │   │   ├── errors.ts     The error taxonomy
│   │   │   ├── logger.ts     Pino, request-aware
│   │   │   ├── redaction.ts  Allowlist filter for log metadata
│   │   │   └── request-context.ts
│   │   ├── rag/
│   │   │   ├── extract-text.ts   The only file that knows about formats
│   │   │   ├── chunking.ts       Pure. No imports, no server-only guard.
│   │   │   ├── embedding-service.ts  Vendor-independent embedding rules
│   │   │   ├── ingest-document.ts    Sequences the pipeline for one file
│   │   │   ├── retrieve.ts       Embed the question, search the corpus
│   │   │   ├── build-context.ts  Fit passages inside the token budget
│   │   │   ├── prompts.ts        Every prompt, including the grounding rules
│   │   │   ├── answer.ts         Retrieve, assemble, generate
│   │   │   └── (citations verification)                     [phase 9]
│   │   ├── security/         Rate limiting, file validation       [phase 12]
│   │   └── storage/          Uploaded originals                   [later]
│   ├── types/
│   ├── instrumentation.ts    Validates config once at startup
│   ├── types/next-auth.d.ts  Adds `id` to the session type
│   └── middleware.ts         Fast redirect, NOT the security boundary
└── tests/
    ├── unit/                 Pure logic, no I/O
    ├── integration/          Real MongoDB, includes cross-user isolation
    ├── stubs/                server-only shim so server code is testable
    ├── e2e/                  [phase 14]
    └── fixtures/make-pdf.ts  Builds real PDFs, including text-less ones
```

---

## What is implemented

**Phases 1 through 7 are complete and verified.** The loop is closed: a
question is embedded, searched against the corpus, and answered from what came
back, with the passages shown alongside.

### Phase 1: foundation

- **Next.js 16 + TypeScript strict + Tailwind v4**, building and serving.
- **Environment handling.** Every variable in a Zod schema with types, defaults
  and ranges. Public and server variables in separate files with a
  build-enforced boundary.
- **Fail-fast startup.** `src/instrumentation.ts` validates configuration once
  at boot, so a bad value stops the server with a clear message.
- **Provider-agnostic model layer.** `LLMProvider` and `EmbeddingProvider`
  interfaces, a registry, a catalog of five vendors and an env-driven factory.
  No vendor implemented yet; asking for one returns `NOT_IMPLEMENTED`.
- **Error taxonomy.** Nine typed classes with stable codes, correct HTTP
  statuses, and a split between the internal message kept for logs and the safe
  message shown to users.
- **Structured logging.** Pino JSON with request id, operation and duration.
  Context flows through `AsyncLocalStorage`.
- **Log redaction.** An allowlist, not a denylist: a field is dropped unless
  explicitly permitted, nested objects are dropped entirely, removals are named.
- **`GET /api/health`** and a server-rendered status home page.
- **Security headers** on every response.

### Phase 2: database

- **Cached connection.** One `MongoClient` pool per process, cached on
  `globalThis` so hot reload cannot leak pools and so no instance ever opens a
  connection per request. The promise is cached rather than the client, so
  concurrent first requests do not race.
- **Ten-second server selection timeout** instead of the driver's thirty, so an
  unreachable cluster surfaces quickly rather than burning a request.
- **Credential redaction for driver errors.** The MongoDB driver puts the
  connection string into several of its own error messages, which is one of the
  most common ways a production password leaks. Every string out of the driver
  passes through `redact.ts` first, and the host is kept while the credentials
  are removed so errors stay actionable.
- **Five collections** with entity types, Zod write validation and indexes.
- **Repository layer** where every function touching owned data requires
  `userId`.
- **Untrusted id parsing.** MongoDB filters are objects, so the injection risk
  is operator injection rather than string concatenation: a body of
  `{"id": {"$ne": null}}` would otherwise match every row. Every id goes
  through `toObjectId`.
- **`GET /api/health/db`.** Pings the database and reports status and latency,
  never the host, database name or driver error.
- **106 tests**, including a `cross-user isolation` suite run against a real
  MongoDB.

### Phase 3: local LLM

- **Ollama provider** implementing the `LLMProvider` interface from Phase 1:
  `complete`, `stream` (NDJSON, ready for the streaming phase) and an
  approximate `countTokens`.
- **`POST /api/ai/chat`** with Zod validation, and a test page at `/ai-test`
  that reports whether Ollama is reachable and the model installed before you
  send anything.
- **Per-provider model resolution.** `LLM_MODEL`, then `<PROVIDER>_MODEL`, then
  a catalog default, so switching `LLM_PROVIDER` does not leave behind a model
  name the new provider has never heard of.
- **`num_ctx` set explicitly.** Ollama defaults its context window to 2048
  whatever the model supports, silently truncating longer prompts. Without
  this, a configured 8192-token window would be a lie, and the truncation is
  invisible: you get a plausible answer that ignored half the input.
- **Every failure mapped to a typed error** with a message that helps:
  `LLM_UNAVAILABLE`, `LLM_MODEL_NOT_FOUND` (which names the exact
  `ollama pull` command), `LLM_TIMEOUT`, `LLM_INVALID_RESPONSE`. The provider's
  own error text never becomes the user's message.
- **The test endpoint was off in production**, answering 404 unless explicitly
  enabled, because it had no authentication yet. That flag is gone; see the
  hosted generation section below.
- **136 tests**, with `fetch` mocked so none of them need a model installed.

### Phase 4: authentication

- **Google OAuth via Auth.js v5** with database-backed sessions, so signing out
  actually revokes access instead of only clearing a cookie.
- **`requireUser()`**, the single source of a user id on the server. It reads
  the session cookie and never trusts an id from a request body, query string
  or header.
- **Protected `/dashboard`**, a `/login` page with loading and error states,
  and **`GET /api/auth/me`** that 401s without a session.
- **OAuth tokens are stripped** before account rows are written, because this
  app never calls Google APIs on a user's behalf and a stored refresh token is
  a long-lived key to somebody's account.
- **Only `openid email profile`** requested. No Drive, Gmail, contacts or
  calendar.
- **Unverified Google emails are rejected**, since accounts are keyed by email
  and accepting an unverified one would be account takeover.
- **The config is built per request, not at import time**, so the app builds on
  a machine with no database and no credentials.
- **170 tests.**

### Phase 4b: hosted generation behind the session

- **`POST /api/ai/chat` requires a signed-in user**, checked on the first line
  of the handler, before the body is read. The `ENABLE_AI_TEST_ENDPOINT` feature
  flag that used to guard it has been removed: a session is a lock, a flag is a
  hidden door.
- **`/ai-test` resolves the session before it renders**, and redirects to
  `/login?callbackUrl=/ai-test` when there is none.
- **Groq is the default provider**, because Ollama cannot be reached from a
  deployed app. `LLM_PROVIDER` defaults to `groq` so a deployment with no
  configuration fails with "GROQ_API_KEY is required" rather than a connection
  refused against `127.0.0.1`.
- **A missing key is a page you can act on**, not a 500: `/ai-test` catches the
  configuration error and names the variable to set. The API keeps saying
  nothing specific to its caller.
- **`userId` on every completion log line**, so model spend is attributable.
  The question and the answer are still absent, and a test asserts the route
  never passes them to the logger rather than trusting redaction to remove them.
- **The retired model was caught before it bit.** Groq shut down
  `llama-3.3-70b-versatile` on 16 August 2026; the catalog default is now
  `openai/gpt-oss-120b`, and `LLM_MAX_OUTPUT_TOKENS` rose to 2048 because
  reasoning tokens count against that ceiling.
- **220 tests**, including a suite for the route itself: no session, no model
  call; malformed body while signed out, still 401; and the provider's own
  error text never reaching the caller.

### Phase 5: embeddings

- **Voyage provider** implementing `EmbeddingProvider`: batching at 128 inputs
  per request, `input_type` set per call so a passage and a question are
  embedded differently, and `output_dimension` requested explicitly.
- **Rows reordered by the index Voyage reports**, not by arrival. A shuffled
  response would otherwise store every chunk against the wrong text, and
  nothing about that failure throws.
- **Every value checked** for length and finiteness before it is returned. A
  `NaN` in a vector poisons every later comparison silently.
- **Chunking service**: paragraph, then sentence, then line, then space, then a
  hard cut. Overlap clamped so a pathological input cannot loop forever.
- **`create-vector-index.ts`**, because a search index is schema and belongs in
  the repository rather than in someone's memory of a dashboard.
- **Separate keys, no fallback.** The Groq key is never used for embeddings and
  the Voyage key is never used for generation, so crossed wiring fails as a
  configuration error rather than a confusing 401.

### Phase 6: document ingestion

- **One shared company knowledge base.** No upload route, no upload UI, no
  upload for anybody. Ingestion runs from a terminal script, so authorization
  is possession of the server's credentials rather than a role check on a
  public endpoint.
- **PDF, Markdown and plain text**, through unpdf (pdf.js): pure JavaScript, no
  native binary to compile, and text returned per page so a citation can name
  one.
- **A scanned PDF is rejected with a message saying so.** It is the failure
  that would otherwise be invisible: a document marked `ready` with no chunks,
  and a chat feature that says "I could not find that" about a file sitting
  right there.
- **Status never lies.** Everything is embedded in memory before anything is
  written, so a failure at chunk 70 of 100 leaves zero chunks stored and the
  document marked `failed` with a reason, rather than a corpus that answers
  from two thirds of a file and looks healthy.
- **Re-running is a no-op.** Documents are identified by a SHA-256 of their
  contents, so a second run cannot silently double the corpus. `--force`
  replaces the chunks rather than adding to them.
- **Page numbers only where they are real.** A `.md` file gets none, because a
  citation pointing at an invented page looks checkable and is not.
- **Vector length checked immediately before the write.** A mismatch does not
  error at write time: the rows land, Atlas quietly refuses to index them, and
  search returns nothing.
- **401 tests.** The ingestion suite runs against a real MongoDB with real PDFs
  built byte by byte, and mocks only the call to Voyage. Among them is a
  regression test asserting that no route, page or component can reach
  ingestion, which fails the moment someone adds an upload endpoint.

### Phase 7: retrieval and grounded answers

- **`POST /api/ai/ask` and the `/chat` page.** Embed the question, search the
  corpus, answer from the passages, return them alongside so the answer can be
  checked rather than trusted.
- **The ownership filter runs INSIDE `$vectorSearch`**, not in a later
  `$match`. Filtering afterwards would fetch the global nearest passages and
  then discard other people's, which silently returns fewer results and puts
  another user's text one mistake away from a prompt.
- **`userId` comes from the session, never the request.** The request schema has
  no user field at all, because a client that could name the user could name any
  user.
- **No model call when nothing matches.** An empty corpus answers "I could not
  find that" rather than inventing something, which is the state every new
  deployment starts in.
- **Passages are fenced and declared as quoted material**, so a document
  containing "ignore your previous instructions" is read as text rather than
  obeyed.
- **A context budget** that drops the lowest-ranked passages rather than letting
  them crowd out the room the answer needs.
- **An unavailable or still-building index says so**, instead of arriving as a
  bare 500 with the reason in a log nobody opened.
- **456 tests.** The security boundary is pinned down by asserting the exact
  aggregation pipeline, because `$vectorSearch` runs inside Atlas Search and
  cannot be executed against the in-memory MongoDB the tests use.

### Verified behaviour

Checked against a real Ollama, a real MongoDB, and a running production build,
not just asserted in tests:

- `/api/health/db` returns `not_configured` (503) with no URI set, `unavailable`
  (503) when the cluster is unreachable, and `ok` (200) with a latency figure
  when it is healthy.
- With a connection string containing a real password pointed at a dead port,
  **zero occurrences** of the password, the username or the connection string
  appear in either the HTTP response or the server logs. The log records
  `MongoServerSelectionError` and `operation: db.connect` instead.
- The healthy response contains no hostname, port or database name.
- An upstream `x-request-id` is reused; a forged one containing JSON and
  newlines is stripped before it reaches the logs.
- Errors log with a readable `errorType` in the minified production build.
- A real question to `llama3.2:1b` returns a real answer with token counts:
  13.4s cold, 0.5s warm.
- All seven invalid-request cases (missing, empty, whitespace-only,
  non-string, non-object body, malformed JSON, oversized) return 400.
- A missing model returns 503 naming the `ollama pull` command; a stopped
  Ollama returns 503 saying so.
- A question containing a distinctive phrase appears **zero times** in the
  server logs. The logs record token counts, model, finish reason and
  duration; never the question or the answer.
- Unauthenticated `/dashboard` redirects to `/login?callbackUrl=%2Fdashboard`;
  unauthenticated `/api/auth/me` returns 401.
- With a real session row and cookie, `/api/auth/me` returns the correct user
  and `/dashboard` renders their name, email and a sign-out button.
- An **expired** session row returns 401: expiry is enforced, not just stored.
- A **forged** cookie gets past middleware and is stopped by `requireUser()`,
  which is the three-layer design working as intended.
- The client secret, client id, session token and user email appear **zero
  times** in the server logs.

Checked again for this phase, against a production build with a real session
row, a real MongoDB, and a stand-in provider speaking the Groq dialect:

- `POST /api/ai/chat` with no cookie returns **401** and never constructs a
  provider, so an anonymous request cannot spend a rate limit.
- A malformed body with no cookie still returns 401, not 400: the session is
  checked before the body is read.
- An **expired** session row and a **forged** cookie both return 401. `/ai-test`
  redirects to `/login?callbackUrl=/ai-test` in the same conditions.
- Signed in with no `GROQ_API_KEY`: the API returns a generic 500 while the log
  line records `variable: "GROQ_API_KEY"` and `errorType: "ConfigurationError"`,
  and `/ai-test` renders a panel naming the variable.
- Signed in with a key: a real round trip returns the answer, token counts and
  duration. The upstream request is `POST /chat/completions` with the key in an
  `Authorization: Bearer` header and **not** in the URL.
- The completion log line carries `userId`, provider, model, token counts,
  finish reason and duration. The question, the answer, the API key, the
  session token, the user's email, `AUTH_SECRET`, `GOOGLE_CLIENT_SECRET` and
  the connection string each appear **zero times** in the logs.
- `GROQ_API_KEY`, `AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `MONGODB_URI` and even
  `api.groq.com` appear **zero times** in the client bundle under
  `.next/static`.

Then confirmed against the real thing, with nothing stubbed: a real Google
account, a real Atlas cluster and a real Groq key.

- Google sign-in completes, a user row and a session row are written to Atlas,
  and `/dashboard` renders the signed-in name, email and user id.
- `/ai-test` answers a real question through `openai/gpt-oss-120b`:
  76 prompt tokens, 133 completion tokens, **0.7s**. The same class of question
  took 13.4s cold against a local 1B model, and the answer is materially better.

### Four ways sign-in fails, and how to tell them apart

Getting the above working surfaced something worth writing down: Auth.js
reports **four unrelated failures under one error code**, `Configuration`. The
login page shows one sentence for all of them, so the useful information is in
the server terminal, under a stack trace, in a different window from the person
reading the error.

| What is actually wrong | What you see | Where to fix it |
| --- | --- | --- |
| A required variable is missing | `Configuration` | `.env.local` |
| The OAuth client is type **Desktop**, not **Web application** | `Configuration`, and the terminal says `invalid_client` | Cloud Console: type cannot be changed, create a new client |
| The redirect URI is not registered | Google's own 400 page, `redirect_uri_mismatch` | Cloud Console, Authorized redirect URIs |
| The database is unreachable | `Configuration`, and a TLS error in the terminal | Atlas, Network Access |

The Desktop-versus-Web distinction is the nastiest of these. A Desktop client
is a *public* client: Google assumes the code ships on someone's machine where
a secret cannot be kept, so it hands you a client secret in the console and
then refuses it at the token endpoint. It also auto-allows any `localhost`
redirect, so the flow gets all the way to the callback before failing, which
points suspicion at the last step rather than the client type.

That is why `src/server/auth/last-error.ts` exists. It captures what Auth.js
actually reported and shows it on the login page in development, so the
diagnosis is where the question is. It is off in production, strips anything
secret-looking first, and keeps its value on `globalThis` because Next.js
bundles routes separately: a plain module-level variable is written by the auth
route and read by the login page as two different copies, which silently
returns nothing. There is a test that fails against that mistake.

### Atlas will break again, and that is expected

The IP access list is the most common reason a working local setup stops
working. Home connections rotate their IP, and Atlas rejects an unlisted one by
dropping the TLS handshake, so the error reads like a certificate problem
rather than a permissions one:

```
MongoServerSelectionError: ... SSL alert number 80
```

Fix it at Atlas, Network Access, Add Current IP Address. When you deploy, there
is no fixed IP to list and you will need `0.0.0.0/0`, at which point the
database password is the only thing protecting your data.

---

## What comes next

| Phase | Delivers |
| --- | --- |
| **8** | Retrieval quality: score thresholds, deduplication, hybrid search |
| **9** | Answer quality: citation verification against what was retrieved |
| **8** | Retrieval quality: thresholds, deduplication, hybrid search |
| **9** | Answer quality, grounding and source citations |
| **10** | Conversations, history and query rewriting |
| **11** | Streaming |
| **12** | Evaluation harness |
| **13** | Security hardening |
| **14** | Error monitoring |
| **15** | Test coverage completion |
| **16** | Cloud provider swap and deployment |
| **17** | OCR for scanned documents |

Tools, function calling and agents come after all of the above.

---

## Architecture notes

**Why there is no Express.** Next.js Route Handlers already do what Express
would, and a custom server costs the platform's routing and caching. Separation
of concerns comes from layering instead: `route handler -> service -> repository
-> provider`, where the service layer imports nothing from Next.js and could be
lifted into a standalone worker if it ever needs to be.

**Why every API route goes through `createRoute()`.** It generates a request id,
times the request, logs the outcome, catches anything thrown, maps it to the
right status, and returns a body that leaks nothing. Without it every handler
has to remember all six, and one of them will forget.

**Why the health check is so careful.** It is unauthenticated, which makes it a
reconnaissance target. Every field it returns is a status word, a public model
name or a number, never a configured value.

**Why `globals.css` uses `@theme inline`.** A plain `@theme` block resolves
each colour at build time and bakes the literal value into every utility, so a
`prefers-color-scheme` media query overriding the variable afterwards has
nothing left to change. `@theme inline` emits `var(--ink)` into the utility
instead, which is what makes the theme switch work. Nesting `@theme` inside a
media query does not work either: the values apply unconditionally. Caught by
screenshotting the page in both schemes and finding them byte-identical.

**Why the health check does not touch the database.** `/api/health` reports
configuration and must stay fast and always available; a slow cluster should not
make it fail. `/api/health/db` is the one that opens a connection. Collapsing
them would mean an outage in the database takes down the endpoint you use to
diagnose it.

**Why folders are empty rather than absent.** The structure documents the plan,
and each README says what will live there and when. It costs nothing and makes
the shape of the finished system visible from day one.
