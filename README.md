# TrueIgnore

A [Vencord](https://vencord.dev) plugin that adds an ignore that actually hides people.

Discord's built-in Ignore only collapses messages behind a "show" button. TrueIgnore removes the person from your client: their messages, DMs, typing indicator, reactions, member list entry and voice presence all go away, and you can mute them in voice too.

Everything happens on your side only. They aren't told, nothing is sent to Discord, and they can still see you and message you. You just won't see any of it.

## What it hides

Each of these has its own toggle in the plugin settings, so you can switch off any part without removing anyone from the list.

| Where they show up | What TrueIgnore does |
|---|---|
| Messages in servers, group DMs and DMs | Removed from chat, including older messages you scroll back to. Also hidden in pins, search results and the inbox |
| New messages arriving live | Dropped before Discord sees them, so there's no unread badge, notification, sound or ping |
| Replies to them from other people | Your choice: Discord's "ignored message" placeholder, remove the reply preview (default), or hide the whole reply |
| @mentions of them | Shown as a generic "@Discord User" pill (the name is configurable), with no profile popout or right-click menu |
| Your DM with them | Removed from the DM list |
| "X is typing…" | Hidden |
| Reactions | Their new reactions are dropped, and they're removed from reaction user lists |
| Server member list | Removed, and role and online counts are adjusted to match |
| Voice channels and calls | Removed from the voice channel list and call tiles, and left out of voice user counts |
| Voice audio | Optionally muted locally, soundboard included. TrueIgnore undoes the mute when you remove them, unless you had already muted them yourself |
| Friend requests and message requests | New ones from them are dropped |

You can also apply all of this to everyone you've blocked, or to everyone you've ignored with Discord's built-in Ignore.

## Using it

- After you turn TrueIgnore on or off, it asks you to **reload Discord**. It has no effect until you do. If you pick Later, a banner with a Reload button stays at the top of Discord.
- **Right-click anyone** (in chat, the member list or your DMs) and pick **True Ignore**. Pick **Remove True Ignore** on the same menu to undo it.
- Or open the plugin settings and paste a **user ID**. That page also lists everyone you've ignored, with a Remove button next to each.
- To turn everything off, disable the plugin. Hidden messages, DMs and voice entries come back, and any mutes TrueIgnore added are undone.

## Installing

TrueIgnore is a user plugin, so you need Vencord built from source. [Vencord's guide](https://docs.vencord.dev/installing/custom-plugins/) walks through it. The short version:

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
git clone https://github.com/aattiaibrahim/true-ignore src/userplugins/trueIgnore
pnpm build
pnpm inject
```

Restart Discord, then enable **TrueIgnore** under Settings → Vencord → Plugins.

To update later, run `git pull` inside `src/userplugins/trueIgnore`, then run `pnpm build` again from the Vencord folder.

## Limitations

- **It only changes your client.** The other person can still message you, react, join your voice channel and see your profile. You won't see it, but it still happens.
- **Old reaction counts can't be corrected.** Discord sends a reaction's count, not who made it, so a reaction they left before you ignored them still counts toward the number. New ones from them are dropped.
- **Mention badges from before startup can stay.** Unread mention counts that Discord loads when you log in come from the server, so a ping they sent while you were offline can still show as a badge until you open the channel. The message itself stays hidden.
- **Member list scrolling can briefly glitch.** Discord's member list loads in slices by position, and hiding someone shifts positions by a row. At worst a placeholder row flashes while you scroll.
- **Discord updates can break it.** Most of TrueIgnore filters Discord's data instead of patching its code, so it's fairly resilient. A few small code patches handle the message list and mentions, and those can break when Discord changes. If something stops being hidden, open an issue.
- **Client mods break Discord's Terms of Service.** Bans for using Vencord are rare, but that's the risk you take.

## How it works

TrueIgnore uses three techniques. For anyone maintaining it:

1. **Flux interceptor.** Drops `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `TYPING_START`, reaction events, incoming friend requests and message-request channels from ignored users before any store sees them.
2. **Store wrappers.** Wraps store getters (`RelationshipStore.isIgnoredForMessage`, `PrivateChannelSortStore`, `ChannelMemberStore`, `VoiceStateStore`, `SortedVoiceStateStore`, `ChannelRTCStore`, `TypingStore`) so the UI never gets ignored users. Filtered results are memoized so React sees stable references. `isIgnoredForMessage` is the check Discord uses everywhere it renders a message, so wrapping it covers chat, replies, search, pins and threads at once.
3. **Four small patches.**
   - One removes collapsed groups that only contain ignored messages.
   - One removes the reply preview.
   - One swaps @mentions of them for a generic pill.
   - One lets the plugin tell `MessageStore` to recheck its cached messages when your list changes.

`test/functional.cjs` loads logged-out Discord with Vencord in headless Chrome and checks all of the above against Discord's real stores, using synthetic events. Instructions are at the top of the file.

## License

GPL-3.0-or-later, same as Vencord.
