# yoto-myo

One command from a folder of audio files to a working Yoto "Make Your Own" card.
No phone app needed: the player writes the card itself.

Tested with a Yoto Mini (firmware 2.23). Needs Node 20.12 or newer. `ffmpeg` and
`ffprobe` are optional but recommended: with them, tracks are ordered by album and
track-number tags, formats Yoto doesn't accept are converted, and embedded cover art is
used.

## One-time setup

1. Go to https://dashboard.yoto.dev, sign in with your Yoto account, and create a
   **public** client with this redirect URL registered exactly:
   `http://127.0.0.1:8787/callback`
   Under Scopes tick `user:content:manage`, `user:icons:manage`,
   `family:devices:view`, `family:devices:control`, `offline_access`.
2. `cp .env.example .env` and paste the client ID into it.
3. `npm install` (for the MQTT client used by the status and wait commands).
4. `node yoto.js --reset-auth` opens a browser for login once; the refresh token is
   cached in `.yoto-token.json` so later runs are silent.

## Everyday use

    node yoto.js <folder>

For a folder with no card yet, it first lists the playlists already on your account and
asks whether to create a new playlist or replace one of them (the card linked to that
playlist keeps working, nothing is rewritten). Then it uploads the audio, builds the
playlist with icons, and, for a new playlist, asks you to put the blank MYO card in the
player and links it.

The player downloads the audio only while it is idle with no card inserted. Take the card
out, leave the player on and online, and it will fetch everything; after that the card
plays offline. `--wait` watches the player and tells you when that has happened. Until
then, playing the card streams it (cloud icon on the display).

Re-running on the same folder updates the same playlist. Cards already linked to it
pick up the change immediately, no re-link needed. Files Yoto has already seen (same
SHA-256) are not re-uploaded or re-transcoded, so re-runs only cost time for new files.

Options:

    --new                  always create a new playlist (skip the new-or-replace question)
    --no-link              upload/update only
    --relink               write another card for this playlist
    --wait                 after uploading, wait until the player has downloaded the content
    --title "..."          playlist title (remembered for later runs; default: playlist.json title, else folder name)
    --icons random|none    picture icons chosen by title hash, or no icons (default: numbers)
    --order name           sort by filename; default sorts by album + track tags when all files have them
    --device NAME          choose the player when you have several
    --dry-run              preview the plan, no network
    --list                 list your playlists
    --delete <cardId>      delete a playlist (asks first)
    --devices              list players
    --list-icons           list Yoto's public icon titles

## Folder layout

A flat folder makes one chapter per file. Sub-folders make one chapter per sub-folder
with the files inside as its tracks, which is how albums work on the player: the dial
moves between chapters and the button moves between tracks.

    my-card/
      01 First Album/             chapter 1 (title from the album tag, else the folder name)
        01 - Opening.flac         tracks, ordered by track tags, else filename
        02 - Second.mp3
      02 Second Album/            chapter 2
        ...
      bonus.mp3                   a loose file is a single-track chapter
      cover.jpg                   optional playlist cover (or cover.png); else art embedded in the first track
      icons/First Album.png       optional 16x16 chapter icon (sub-folder name or chapter title)
      icons/01 - Opening.png      optional 16x16 track icon (same basename as the audio)
      playlist.json               optional
      .converted/                 written by the tool: m4a conversions of flac/ogg/wav/etc.
      .yoto-card.json             written by the tool: card ID, link status, cover

Chapters and loose files are ordered together by name (numeric-aware, so `2 x` comes
before `10 y`). Leading numbers are stripped from titles. Accepted as-is: mp3, m4a.
Converted locally with ffmpeg first: flac, ogg, opus, wav, aac, wma, aiff.

`playlist.json` lets you set the title, order, titles and icons explicitly. Flat form:

    {
      "title": "Bedtime stories",
      "tracks": [
        { "file": "01 - First story.mp3", "title": "The Lion", "icon": "Lion" },
        { "file": "02 - Second story.m4a", "icon": "Moon" }
      ]
    }

Chapter form (`folder` and `tracks` are each optional; omit `tracks` to take every file
in the folder, in tag order):

    {
      "title": "Analord",
      "chapters": [
        { "folder": "01 Analord 02", "icon": "Robot" },
        { "folder": "02 Analord 03", "title": "Analord Three",
          "tracks": [ { "file": "01 Pitcard.m4a", "icon": "Star" } ] }
      ]
    }

`icon` is a public Yoto icon title from `--list-icons`. Icon precedence, for chapters
and tracks alike: custom PNG in `icons/`, then `icon` in playlist.json, then the
`--icons` mode (numbers by default: chapter number for chapters, track number within the
chapter for tracks).

## Is my card downloaded yet?

    node yoto-status.js            # or: --watch, --device NAME, --wait

Shows whether the current track is streaming or playing from local storage, free space,
and whether a background download is running. `--wait` does the same watching as
`yoto.js --wait` without uploading first.

## How it works

- Audio is uploaded to Yoto's media API, which transcodes it to Opus and dedupes by
  SHA-256. The playlist is a normal MYO playlist on your account, so it also shows up
  in the Yoto app and on my.yotoplay.com.
- Linking sends the player the same `card-link` command the official app uses. The
  player reads the blank card, fetches a signed URL from Yoto, and writes the tag itself.
- Status comes from the same MQTT broker the app uses, authenticated with your token.
- Nothing here talks to the player over NFC or touches its firmware. Cards made this
  way are ordinary MYO cards and keep working if you later delete this tool.
- `playlists/` is git-ignored, so keep your folders there. Audio files anywhere, `.env`,
  the cached login, `.converted/` and `.yoto-card.json` are ignored too.

## Files

- `yoto.js` — the guided one-step command
- `yoto-upload.js` — upload + playlist build (also runnable on its own)
- `yoto-link.js` — link via player (also runnable: `node yoto-link.js <folder>`)
- `yoto-status.js` — live player status over MQTT (streaming vs local, download progress)
- `yoto-auth.js` — shared OAuth login
- `lib/manifest.js` — folder → chapters/tracks/icons manifest, no Yoto dependency
- `lib/convert.js` — ffmpeg conversion and cover extraction
- `lib/mqtt.js` — player connection and download waiting

`npm run lint` runs eslint.
