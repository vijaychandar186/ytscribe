# ytscribe

Paste a YouTube video or playlist URL, get every transcript as copy-ready text — individually or merged in playlist order.

## What it does

- Resolves a playlist (or single video) URL into its constituent videos via `youtubei.js`.
- Pulls subtitles (manual first, auto-generated as fallback) for each video using `yt-dlp`.
- Normalizes the captions to clean prose and renders one card per video plus a merged-all view.
- One-click copy on every card; URL + language + results persist in `localStorage` so a refresh doesn't lose your work.

## Stack

- Next.js 16 (App Router, Turbopack) on Node runtime
- React 19
- shadcn/ui + Tailwind CSS v4
- `youtubei.js` for playlist resolution
- `youtube-dl-exec` (ships a vendored `yt-dlp` binary) for subtitle fetching
- Hugeicons for icons

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a YouTube URL, hit **Fetch transcripts**.

## Options

The form has an **Options (optional)** disclosure with two settings — both are optional and have sensible fallbacks:

### Subtitle language

ISO language code passed to yt-dlp's `--sub-lang`. Defaults to `en`. Examples: `es`, `ja`, `de`, `pt`. Language preference is persisted to `localStorage` alongside the URL.

### YouTube cookies

A `cookies.txt` export in Netscape format. Paste it when YouTube starts returning `Sign in to confirm you're not a bot` errors on anonymous requests — common for high-volume or VPN traffic. The route writes the cookies to a per-request temp file and passes `--cookies` to yt-dlp.

**Privacy:** cookies entered in the form are kept in memory only and are **never** written to `localStorage`. They re-enter the page state empty on every reload.

If you'd rather configure cookies server-side (e.g. for a deployed instance), set:

```bash
# .env.local
YOUTUBE_COOKIES="<paste full cookies.txt contents here>"
```

The form value takes precedence over the env var when both are set.

## How the route works

[app/api/transcripts/route.ts](app/api/transcripts/route.ts):

1. Parses the URL — playlist ID wins; falls back to a single video ID.
2. Walks the playlist with continuations until exhausted, dedupes by video ID.
3. Spawns `yt-dlp` in parallel (concurrency 2) with `--write-sub --write-auto-sub --sub-format json3/vtt/srv3/best`.
4. Reads whichever subtitle file landed, prefers `.json3` (structured), parses to plain text, strips timestamp noise.
5. Returns each video's status (`ready` / `missing` / `error`) plus a single concatenated `mergedText`.

`youtube-dl-exec` is listed in `serverExternalPackages` (see [next.config.ts](next.config.ts)) so Turbopack doesn't bundle it — otherwise its `__dirname`-based binary lookup breaks and every fetch returns "Video unavailable."

## API

`POST /api/transcripts`

```ts
type RequestBody = {
  url: string;            // required: any YouTube video or playlist URL
  language?: string;      // optional: ISO code, defaults to "en"
  cookies?: string;       // optional: Netscape cookies.txt body
};

type ResponseBody = {
  count: number;          // total videos resolved
  readyCount: number;     // videos with a usable transcript
  mergedText: string;     // every ready transcript joined in order
  items: Array<{
    id: string;
    title: string;
    url: string;
    index: number;
    text: string;
    status: "ready" | "missing" | "error";
    error?: string;
  }>;
};
```

## Project layout

```
app/
  api/transcripts/route.ts   # POST handler that drives yt-dlp
  layout.tsx, page.tsx       # Shell + entry
components/
  transcript-client.tsx      # The whole UI (single client component)
  ui/                        # shadcn primitives
next.config.ts               # serverExternalPackages + outputFileTracingIncludes for yt-dlp
```

## Troubleshooting

- **All transcripts come back "unavailable"** — likely YouTube bot detection. Paste cookies into the Options panel (or set `YOUTUBE_COOKIES`).
- **"Use a valid YouTube video or playlist URL"** — URL must include either `?v=`, `?list=`, `youtu.be/<id>`, `/shorts/<id>`, or `/embed/<id>`.
- **Long playlists time out** — `maxDuration` is 60s on the route. Split very large playlists or raise the limit if your host allows.

## License

MIT.
