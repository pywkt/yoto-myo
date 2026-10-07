# yoto-myo

One command from a folder of audio files to a working Yoto "Make Your Own" card.
No phone app needed: the player writes the card itself.

Tested with a Yoto Mini (firmware 2.23). Needs Node 20.12 or newer. `ffprobe` (from
ffmpeg) is optional; with it, tracks are ordered by album and track-number tags.

## One-time setup

1. Go to https://dashboard.yoto.dev, sign in with your Yoto account, and create a
   **public** client with this redirect URL registered exactly:
   `http://127.0.0.1:8787/callback`
   Under Scopes tick `user:content:manage`, `user:icons:manage`,
   `family:devices:view`, `family:devices:control`, `offline_access`.
2. `cp .env.example .env` and paste the client ID into it.
3. `node yoto.js --reset-auth` opens a browser for login once; the refresh token is
   cached in `.yoto-token.json` so later runs are silent.

## Everyday use

    node yoto.js <folder>

For a folder with no card yet, it first lists the playlists already on your account and
asks whether to create a new playlist or replace one of them (the card linked to that
playlist keeps working, nothing is rewritten). Then it uploads the audio, builds the
playlist with a numbered icon per track, and, for a new playlist, asks you to put the
blank MYO card in the player and links it. Play the card once while online so the player caches it; after that it plays
offline (the first play shows the cloud icon while it downloads).

Re-running on the same folder updates the same playlist. Cards already linked to it
pick up the change immediately, no re-link needed. Files Yoto has already seen (same
SHA-256) are not re-uploaded or re-transcoded, so re-runs only cost time for new files.

Transcoding happens on Yoto's servers (output is Opus); it cannot be done locally.
To reuse a card for a different folder, pick its playlist from the list when asked
(or copy its `.yoto-card.json` into the new folder). To physically re-write a card for
a brand-new playlist instead, create the playlist and answer yes to the link question.

Options:

    --new                  always create a new playlist (skip the new-or-replace question)
    --no-link              upload/update only
    --relink               write another card for this playlist
    --icons random|none    picture icons chosen by title hash, or no icons (default: numbers)
    --order name           sort by filename; default sorts by album + track tags when all files have them
    --device NAME          choose the player when you have several
    --dry-run              preview the plan
    --devices              list players
    --list-icons           list Yoto's public icon titles

## Is my card downloaded yet?

    npm install            # once, for the MQTT client
    node yoto-status.js    # or: node yoto-status.js --watch

Shows whether the current track is streaming or playing from local storage, free space,
and whether a background download is running. The player only downloads new content
while it is idle with no card inserted, so after uploading: eject the card and leave the
player on, online and charging for a while. Until then every play streams (cloud icon).

## Folder layout

    my-playlist/
      01 - First story.mp3      audio, sorted by filename; leading numbers are stripped from titles
      02 - Second story.m4a
      playlist.json             optional
      icons/01 - First story.png  optional 16x16 PNG custom icon, same basename as the audio
      .yoto-card.json           written by the tool: card ID, link status

`playlist.json` lets you set the title, order, titles and icons explicitly:

    {
      "title": "Bedtime stories",
      "tracks": [
        { "file": "01 - First story.mp3", "title": "The Lion", "icon": "Lion" },
        { "file": "02 - Second story.m4a", "icon": "Moon" }
      ]
    }

`icon` is a public Yoto icon title from `--list-icons`. Icon precedence per track:
custom PNG in `icons/`, then `icon` in playlist.json, then the `--icons` mode.

## Files

- `yoto.js` — the guided one-step command
- `yoto-upload.js` — upload + playlist build (also runnable on its own)
- `yoto-link.js` — link via player (also runnable: `node yoto-link.js <folder>`)
- `yoto-status.js` — live player status over MQTT (streaming vs local)
- `yoto-auth.js` — shared OAuth login

## How it works

- Audio is uploaded to Yoto's media API, which transcodes it to Opus and dedupes by
  SHA-256. The playlist is a normal MYO playlist on your account, so it also shows up
  in the Yoto app and on my.yotoplay.com.
- Linking sends the player the same `card-link` command the official app uses. The
  player reads the blank card, fetches a signed URL from Yoto, and writes the tag itself.
- Nothing here talks to the player over NFC or touches its firmware. Cards made this
  way are ordinary MYO cards and keep working if you later delete this tool.
- Your audio, `.env`, the cached login and `.yoto-card.json` files are git-ignored.
