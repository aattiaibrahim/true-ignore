// Functional test for TrueIgnore: loads logged-out Discord with the Vencord web build,
// feeds synthetic Flux events, and checks what the stores expose.
//
// Usage (from the Vencord root):
//   pnpm buildWeb
//   CHROMIUM_BIN="/path/to/chrome" node src/userplugins/trueIgnore/test/functional.cjs
const { createRequire } = require("module");
const path = require("path");
const fs = require("fs");

// This file lives in Vencord/src/userplugins/trueIgnore/test
const VENCORD = path.resolve(__dirname, "../../../..");
const req = createRequire(path.join(VENCORD, "package.json"));
const pup = req("puppeteer-core");

const IGN = "111111111111111111";
const OK = "222222222222222222";

(async () => {
    const browser = await pup.launch({ headless: true, executablePath: process.env.CHROMIUM_BIN, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36");
    page.on("console", m => { const t = m.text(); if (/TrueIgnore|Failed to start/.test(t)) console.error("[page]", t); });

    const settings = { plugins: { TrueIgnore: { enabled: true, users: { [IGN]: { username: "ign", addedAt: 0 } } } } };
    await page.evaluateOnNewDocument(`
        if (location.host.endsWith("discord.com")) {
            window.localStorage.setItem("VencordSettings", ${JSON.stringify(JSON.stringify(settings))});
            ${fs.readFileSync(path.join(VENCORD, "dist/browser.js"), "utf-8")};
        }
    `);
    await page.goto("https://discord.com/login");
    await page.waitForFunction(() => { const C = window.Vencord?.Webpack?.Common; return C?.MessageStore?.getMessages && C?.FluxDispatcher?.dispatch && C?.VoiceStateStore?.getVoiceStatesForChannel && C?.TypingStore?.getTypingUsers; }, { timeout: 60000 });
    // Vencord only starts plugins after login, so start this one by hand. Its patches were already applied on page load.
    await page.evaluate(() => Vencord.Plugins.startPlugin(Vencord.Plugins.plugins.TrueIgnore));

    const results = await page.evaluate(async (IGN, OK) => {
        const C = Vencord.Webpack.Common;
        const { FluxDispatcher: D, MessageStore, TypingStore, VoiceStateStore, RelationshipStore } = C;
        const findStore = Vencord.Webpack.findStore;
        const PCS = findStore("PrivateChannelSortStore");
        const CMS = findStore("ChannelMemberStore");
        const out = {};
        const check = (name, cond, extra) => { out[name] = cond ? "PASS" : `FAIL ${JSON.stringify(extra ?? "")}`; };
        const tick = () => new Promise(r => setTimeout(r, 50));

        const user = (id, name) => ({ id, username: name, discriminator: "0", avatar: null, global_name: null });
        const fromServer = Vencord.Webpack.findByCode(".GUILD_TEXT]", "fromServer)");
        const dm = (id, u) => fromServer({ id, type: 1, recipients: [user(u, u === IGN ? "ign" : "ok")], last_message_id: null, flags: 0 });
        const msg = (id, ch, authorId, extra = {}) => ({ id, channel_id: ch, author: user(authorId, authorId === IGN ? "ign" : "ok"), content: `hi from ${authorId}`, timestamp: new Date().toISOString(), edited_timestamp: null, attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, mention_everyone: false, tts: false, type: 0, flags: 0, reactions: [], ...extra });

        const DM_IGN = "900000000000000001", DM_OK = "900000000000000002";

        // DM list
        D.dispatch({ type: "CHANNEL_CREATE", channel: dm(DM_IGN, IGN) });
        D.dispatch({ type: "CHANNEL_CREATE", channel: dm(DM_OK, OK) });
        await tick();
        const ids = PCS.getPrivateChannelIds();
        check("dmList hides ignored DM", !ids.includes(DM_IGN) && ids.includes(DM_OK), { ids, raw: Object.getPrototypeOf(PCS).getPrivateChannelIds.call(PCS), ch: C.ChannelStore.getChannel(DM_OK)?.type, priv: Object.keys(C.ChannelStore.getMutablePrivateChannels?.() ?? {}) });
        check("dmList stable reference", PCS.getPrivateChannelIds() === ids);

        // Message history: ignored flag
        D.dispatch({ type: "LOAD_MESSAGES_SUCCESS", channelId: DM_OK, messages: [msg("910000000000000003", DM_OK, OK), msg("910000000000000002", DM_OK, IGN), msg("910000000000000001", DM_OK, OK)], isBefore: false, isAfter: false, hasMoreBefore: false, hasMoreAfter: false, limit: 50, jump: undefined, isStale: false, truncate: false });
        await tick();
        const flags = () => Object.fromEntries(MessageStore.getMessages(DM_OK).toArray().map(m => [m.author.id, m.ignored]));
        check("history: ignored author flagged", flags()[IGN] === true && flags()[OK] === false, flags());

        // Reply by OK to IGN, with replyMode=hideMessage
        Vencord.Settings.plugins.TrueIgnore.replyMode = "hideMessage";
        await tick();
        D.dispatch({ type: "MESSAGE_CREATE", channelId: DM_OK, message: msg("910000000000000010", DM_OK, OK, { type: 19, message_reference: { channel_id: DM_OK, message_id: "910000000000000002" }, referenced_message: msg("910000000000000002", DM_OK, IGN) }) });
        await tick();
        check("hideMessage mode drops live reply to ignored", !MessageStore.getMessage(DM_OK, "910000000000000010"));
        Vencord.Settings.plugins.TrueIgnore.replyMode = "hidePreview";
        await tick();
        D.dispatch({ type: "MESSAGE_CREATE", channelId: DM_OK, message: msg("910000000000000011", DM_OK, OK, { type: 19, message_reference: { channel_id: DM_OK, message_id: "910000000000000002" }, referenced_message: msg("910000000000000002", DM_OK, IGN) }) });
        await tick();
        check("hidePreview mode keeps the reply", !!MessageStore.getMessage(DM_OK, "910000000000000011"));

        // Toggling hideMessages off/on recomputes flags on cached messages (the refresh patch)
        Vencord.Settings.plugins.TrueIgnore.hideMessages = false;
        await tick();
        check("refresh: turning hideMessages off unhides cached messages", flags()[IGN] === false, flags());
        Vencord.Settings.plugins.TrueIgnore.hideMessages = true;
        await tick();
        check("refresh: turning hideMessages on re-hides", flags()[IGN] === true, flags());

        // Live messages
        D.dispatch({ type: "MESSAGE_CREATE", channelId: DM_OK, message: msg("910000000000000020", DM_OK, IGN) });
        D.dispatch({ type: "MESSAGE_CREATE", channelId: DM_OK, message: msg("910000000000000021", DM_OK, OK) });
        await tick();
        check("live message from ignored dropped", !MessageStore.getMessage(DM_OK, "910000000000000020"));
        check("live message from others kept", !!MessageStore.getMessage(DM_OK, "910000000000000021"));

        // Typing
        D.dispatch({ type: "TYPING_START", channelId: DM_OK, userId: IGN });
        D.dispatch({ type: "TYPING_START", channelId: DM_OK, userId: OK });
        await tick();
        const typing = TypingStore.getTypingUsers(DM_OK);
        check("typing hides ignored", !(IGN in typing) && (OK in typing), typing);

        // Reactions
        const emoji = { id: null, name: "👍" };
        D.dispatch({ type: "MESSAGE_REACTION_ADD", channelId: DM_OK, messageId: "910000000000000021", userId: IGN, emoji, reactionType: 0 });
        await tick();
        check("reaction from ignored dropped", (MessageStore.getMessage(DM_OK, "910000000000000021").reactions ?? []).length === 0);
        D.dispatch({ type: "MESSAGE_REACTION_ADD", channelId: DM_OK, messageId: "910000000000000021", userId: OK, emoji, reactionType: 0 });
        await tick();
        check("reaction from others kept", MessageStore.getMessage(DM_OK, "910000000000000021").reactions?.[0]?.count === 1);

        // Friend request
        D.dispatch({ type: "RELATIONSHIP_ADD", relationship: { id: IGN, type: 3, user: user(IGN, "ign"), since: new Date().toISOString() } });
        await tick();
        check("friend request from ignored dropped", RelationshipStore.getRelationshipType(IGN) !== 3);

        // Voice
        const vs = (userId) => ({ userId, channelId: "930000000000000001", guildId: "940000000000000001", sessionId: "s" + userId, deaf: false, mute: false, selfDeaf: false, selfMute: false, selfVideo: false, suppress: false });
        D.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [vs(IGN), vs(OK)] });
        await tick();
        const voice = VoiceStateStore.getVoiceStatesForChannel("930000000000000001");
        check("voice hides ignored", !(IGN in voice) && (OK in voice), Object.keys(voice));

        // Member list
        D.dispatch({ type: "GUILD_MEMBER_LIST_UPDATE", guildId: "940000000000000001", id: "everyone", memberCount: 3, onlineCount: 3, groups: [{ id: "online", count: 2 }, { id: "offline", count: 1 }], ops: [{ op: "SYNC", range: [0, 99], items: [{ group: { id: "online", count: 2 } }, { member: { user: user(IGN, "ign"), roles: [] } }, { member: { user: user(OK, "ok"), roles: [] } }, { group: { id: "offline", count: 1 } }, { member: { user: user(IGN, "ign"), roles: [] } }] }] });
        await tick();
        const props = CMS.getProps("940000000000000001", null);
        const rowIds = props.rows.map(r => r?.type === "GROUP" ? `G:${r.id}:${r.count}:${r.index}` : r?.user?.id);
        check("member list hides ignored and fixes groups",
            !rowIds.includes(IGN) && props.groups.length === 1 && props.groups[0].count === 1 && props.groups[0].index === 0 && props.rows.length === 2,
            { rowIds, groups: props.groups });
        check("member list stable reference", CMS.getProps("940000000000000001", null).rows === props.rows);

        // Local voice mute: toggling muteInVoice applies/reverts
        const MES = C.MediaEngineStore;
        Vencord.Settings.plugins.TrueIgnore.muteInVoice = false;
        await tick();
        const beforeMute = MES.isLocalMute(IGN);
        Vencord.Settings.plugins.TrueIgnore.muteInVoice = true;
        await tick(); await tick();
        check("mute: muteInVoice on mutes them", MES.isLocalMute(IGN) === true && beforeMute === false, { beforeMute, after: MES.isLocalMute(IGN), entry: Vencord.Settings.plugins.TrueIgnore.users[IGN] });
        check("mute: remembered that we muted them", Vencord.Settings.plugins.TrueIgnore.users[IGN]?.mutedByUs === true);

        // Settings panel renders
        const root = document.createElement("div"); document.body.appendChild(root);
        const Comp = Vencord.Plugins.plugins.TrueIgnore.settings.def.ignoredUsersList.component;
        try {
            const r = Vencord.Webpack.Common.createRoot(root);
            r.render(Vencord.Webpack.Common.React.createElement(Comp, {}));
            await new Promise(r => setTimeout(r, 500));
            check("settings panel renders the ignored user", root.textContent.includes("ign") && root.textContent.includes(IGN), root.textContent.slice(0, 300));
            r.unmount();
        } catch (e) { check("settings panel renders the ignored user", false, String(e)); }

        // Disabling the plugin brings everything back
        Vencord.Plugins.stopPlugin(Vencord.Plugins.plugins.TrueIgnore);
        await tick();
        check("stop: DM back", PCS.getPrivateChannelIds().includes(DM_IGN));
        check("stop: messages unhidden", flags()[IGN] === false, flags());
        check("stop: voice back", IGN in VoiceStateStore.getVoiceStatesForChannel("930000000000000001"));
        check("stop: interceptor removed", !FluxDispatcher_hasInterceptor());
        await tick();
        check("stop: unmutes users we muted", MES.isLocalMute(IGN) === false);
        function FluxDispatcher_hasInterceptor() { return D._interceptors.some(f => f.toString().includes("MESSAGE_REACTION_ADD_USERS")); }

        return out;
    }, IGN, OK);

    console.log(JSON.stringify(results, null, 2));
    const failed = Object.values(results).filter(v => v !== "PASS").length;
    console.log(failed ? `${failed} FAILED` : "ALL PASSED");
    await browser.close();
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
