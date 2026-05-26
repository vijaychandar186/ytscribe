# ytscribe

Paste a YouTube video or playlist URL, get every transcript as copy-ready text — individually or merged in playlist order. No binaries, no Python, no yt-dlp — just YouTube's own caption tracks.

## What it does

- Resolves a playlist (or single video) URL into its constituent videos via `youtubei.js`.
- For each video, reads the available caption tracks from the player response and picks one matching your language (manual track preferred, auto-generated as fallback).
- Downloads the track in `json3` format directly from YouTube's `timedtext` endpoint and renders clean prose.
- Shows one card per video plus a merged-all view; one-click copy on every card.
- URL + language + results persist in `localStorage` so a refresh doesn't lose your work.

## Stack

- Next.js 16 (App Router, Turbopack) on Node runtime
- React 19
- shadcn/ui + Tailwind CSS v4
- `youtubei.js` — sole dependency for talking to YouTube (playlist resolution + caption track URLs)
- Hugeicons for icons

No bundled binaries. The serverless function is small enough to deploy comfortably on Vercel Hobby.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste a YouTube URL, hit **Fetch transcripts**.

## Options

The form has an **Options (optional)** disclosure under the URL input:

### Subtitle language

ISO language code matched against each video's `caption_tracks[].language_code`. Defaults to `en`. Examples: `es`, `ja`, `de`, `pt`. The match is case-insensitive and also accepts loose variants (`en` matches `en-US`, `en-GB`, etc.). For each video the route prefers a manual track over an auto-generated (`kind: "asr"`) one in your chosen language.

Language preference is persisted to `localStorage` alongside the URL.

## How the route works

[app/api/transcripts/route.ts](app/api/transcripts/route.ts):

1. Parses the URL — playlist ID wins; falls back to a single video ID.
2. Walks the playlist with continuations until exhausted, dedupes by video ID.
3. For each video (concurrency 3): calls `Innertube.getBasicInfo(videoId, { client: "IOS" })`, reads `info.captions.caption_tracks`, picks the best match for the requested language (manual track preferred over auto-generated).
4. Fetches the track's `base_url` with `&fmt=json3` and parses the structured events into plain text.
5. Returns each video's status (`ready` / `missing` / `error`) plus a single concatenated `mergedText`.

### Why the IOS client

Modern YouTube gates caption metadata behind a **PO Token** (Proof-of-Origin) when fetched via the WEB InnerTube client — without one, `caption_tracks` comes back empty. The IOS client is exempt from this and returns the full track list. yt-dlp does the same dance for the same reason; see its YouTube extractor around the `_report_pot_subtitles_skipped` path.

## API

`POST /api/transcripts`

```ts
type RequestBody = {
  url: string;            // required: any YouTube video or playlist URL
  language?: string;      // optional: ISO code, defaults to "en"
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
  api/transcripts/route.ts   # POST handler — Innertube + timedtext only
  layout.tsx, page.tsx       # Shell + entry
components/
  transcript-client.tsx      # The whole UI (single client component)
  ui/                        # shadcn primitives
```

## Troubleshooting

- **"This video has no captions"** — the video genuinely has no caption tracks (private uploads, music videos, very new uploads).
- **`No "<lang>" captions available`** — the video has captions but none in your requested language. Try `en` or another code from the video's caption settings.
- **"Use a valid YouTube video or playlist URL"** — URL must include either `?v=`, `?list=`, `youtu.be/<id>`, `/shorts/<id>`, or `/embed/<id>`.
- **Long playlists time out** — `maxDuration` is 60s on the route. Split very large playlists or raise the limit if your host allows.

## License

MIT.
