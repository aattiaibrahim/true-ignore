/*
 * TrueIgnore, a Vencord user plugin
 * Copyright (c) 2026 aattiaibrahim
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import { findStore } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    MediaEngineStore,
    Menu,
    MessageStore,
    RelationshipStore,
    showToast,
    SoundboardStore,
    Toasts,
    TypingStore,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

import { IgnoredUsersList } from "./IgnoredUsersList";
import { watchForToggle } from "./reloadPrompt";

const logger = new Logger("TrueIgnore");

/** Custom Flux action. A patch makes MessageStore recompute its `ignored` flags when it sees this. */
const REFRESH_ACTION = "TRUE_IGNORE_REFRESH";

const MESSAGE_TYPE_REPLY = 19;
const CHANNEL_TYPE_DM = 1;
const RELATIONSHIP_PENDING_INCOMING = 3;

export interface IgnoredUser {
    username: string;
    addedAt: number;
    /** We turned on Discord's local mute for them, so we should turn it off again when they're removed */
    mutedByUs?: boolean;
    soundboardMutedByUs?: boolean;
}

type ReplyMode = "placeholder" | "hidePreview" | "hideMessage";

export const settings = definePluginSettings({
    ignoredUsersList: {
        type: OptionType.COMPONENT,
        component: IgnoredUsersList
    },
    users: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, IgnoredUser>
    },
    hideMessages: {
        type: OptionType.BOOLEAN,
        description: "Hide their messages in servers, group DMs and DMs, including older ones you scroll back to",
        default: true,
        onChange: () => refresh()
    },
    blockLiveMessages: {
        type: OptionType.BOOLEAN,
        description: "Drop their new messages as they arrive: no unread badge, notification, sound or ping",
        default: true
    },
    replyMode: {
        type: OptionType.SELECT,
        description: "What to do when someone else replies to them",
        options: [
            { label: "Show Discord's \"ignored message\" placeholder in the reply preview", value: "placeholder" },
            { label: "Remove the reply preview but keep the reply", value: "hidePreview", default: true },
            { label: "Hide the whole reply (this hides other people's messages too)", value: "hideMessage" }
        ],
        onChange: () => refresh()
    },
    anonymizeMentions: {
        type: OptionType.BOOLEAN,
        description: "When someone @mentions them, show a generic name instead of theirs, with no profile popout",
        default: true,
        onChange: () => refresh()
    },
    mentionPlaceholder: {
        type: OptionType.STRING,
        description: "Name to show in place of theirs in @mentions",
        default: "Discord User",
        onChange: () => refresh()
    },
    hideDMs: {
        type: OptionType.BOOLEAN,
        description: "Hide your DM with them from the DM list",
        default: true,
        onChange: () => refresh()
    },
    blockRequests: {
        type: OptionType.BOOLEAN,
        description: "Drop new friend requests and message requests from them",
        default: true
    },
    hideTyping: {
        type: OptionType.BOOLEAN,
        description: "Hide \"<user> is typing…\"",
        default: true,
        onChange: () => refresh()
    },
    hideReactions: {
        type: OptionType.BOOLEAN,
        description: "Hide their new reactions and remove them from reaction user lists",
        default: true
    },
    hideInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Hide them from the server member list (role counts are adjusted, but may briefly be off)",
        default: true,
        onChange: () => refresh()
    },
    hideInVoice: {
        type: OptionType.BOOLEAN,
        description: "Hide them from voice channel participants and call tiles",
        default: true,
        onChange: () => refresh()
    },
    muteInVoice: {
        type: OptionType.BOOLEAN,
        description: "Locally mute them and their soundboard in voice. Undone when you remove them or turn this off",
        default: true,
        onChange: () => syncAllMutes()
    },
    includeBlocked: {
        type: OptionType.BOOLEAN,
        description: "Also apply all of this to everyone you've blocked",
        default: false,
        onChange: () => refresh()
    },
    includeNativeIgnored: {
        type: OptionType.BOOLEAN,
        description: "Also apply all of this to users you ignored with Discord's built-in Ignore",
        default: false,
        onChange: () => refresh()
    }
});

// ---------------------------------------------------------------------------
// Who is ignored
// ---------------------------------------------------------------------------

let running = false;

export function isRunning() {
    return running;
}

/** Bumped whenever the ignore list, a setting or your block/ignore list changes, so memoized results are invalidated */
let version = 0;
let ignoredIds = new Set<string>();

// Plain copy of the settings. Reading settings.store goes through Vencord's settings proxy,
// which is slow for code that runs on every message render and every Flux event.
let opts = {} as ReturnType<typeof readOptions>;

function readOptions() {
    const s = settings.store;
    return {
        hideMessages: s.hideMessages,
        blockLiveMessages: s.blockLiveMessages,
        replyMode: s.replyMode as ReplyMode,
        anonymizeMentions: s.anonymizeMentions,
        mentionPlaceholder: `@${s.mentionPlaceholder?.trim() || "Discord User"}`,
        hideDMs: s.hideDMs,
        blockRequests: s.blockRequests,
        hideTyping: s.hideTyping,
        hideReactions: s.hideReactions,
        hideInMemberList: s.hideInMemberList,
        hideInVoice: s.hideInVoice,
        includeBlocked: s.includeBlocked,
        includeNativeIgnored: s.includeNativeIgnored
    };
}

function syncOptions() {
    opts = readOptions();
    ignoredIds = new Set(Object.keys(settings.store.users ?? {}));
    version++;
}

// With "include blocked/ignored" on, blocking or ignoring someone in Discord changes who is hidden
function onRelationshipsChange() {
    if (opts.includeBlocked || opts.includeNativeIgnored) version++;
}

export function isTrulyIgnored(userId: string) {
    return ignoredIds.has(userId);
}

/** Whether a user should be hidden. False for yourself and for anyone not on the list. */
export function isHidden(userId?: string | null): boolean {
    if (!running || !userId) return false;
    if (ignoredIds.has(userId)) return userId !== UserStore.getCurrentUser()?.id;

    const { includeBlocked, includeNativeIgnored } = opts;
    if (!includeBlocked && !includeNativeIgnored) return false;

    return (includeBlocked && RelationshipStore.isBlocked(userId))
        || (includeNativeIgnored && RelationshipStore.isIgnored(userId));
}

// Works for both raw gateway messages and Discord's MessageRecords
function isAuthoredByHidden(message: any): boolean {
    if (message == null) return false;

    const authorId = message.author?.id
        ?? MessageStore.getMessage(message.channel_id, message.id)?.author?.id;

    return isHidden(authorId)
        || isHidden(message.interactionMetadata?.user?.id ?? message.interaction_metadata?.user?.id);
}

let ReferencedMessageStore: any;

function getRepliedToAuthorId(message: any): string | undefined {
    if (message?.type !== MESSAGE_TYPE_REPLY) return;

    const rawId = message.referenced_message?.author?.id;
    if (rawId) return rawId;

    const ref = message.messageReference ?? message.message_reference;
    if (ref?.message_id == null) return;

    return ReferencedMessageStore?.getMessageByReference(ref)?.message?.author?.id
        ?? MessageStore.getMessage(ref.channel_id, ref.message_id)?.author?.id;
}

function isReplyToHidden(message: any) {
    return isHidden(getRepliedToAuthorId(message));
}

// Discord asks about the same message records over and over while rendering. Records are
// immutable, so the answer only changes when `version` does.
const messageCache = new WeakMap<object, { v: number; hide: boolean; }>();

/** Whether a message should be treated as ignored (and therefore hidden) */
export function shouldHideMessage(message: any): boolean {
    if (!running || message == null || typeof message !== "object") return false;

    const cached = messageCache.get(message);
    if (cached?.v === version) return cached.hide;

    const hide = (opts.hideMessages && isAuthoredByHidden(message))
        || (opts.replyMode === "hideMessage" && isReplyToHidden(message));

    // A reply's target can finish loading later, so don't cache a "no" that depends on it
    if (hide || opts.replyMode !== "hideMessage" || message.type !== MESSAGE_TYPE_REPLY)
        messageCache.set(message, { v: version, hide });

    return hide;
}

// ---------------------------------------------------------------------------
// Refreshing the UI after a change
// ---------------------------------------------------------------------------

let storesToRefresh: any[] = [];

function runOutsideDispatch(fn: () => void) {
    if (FluxDispatcher.isDispatching()) setTimeout(fn, 0);
    else fn();
}

function refresh() {
    syncOptions();
    memberListCache.clear();

    runOutsideDispatch(() => {
        try {
            FluxDispatcher.dispatch({ type: REFRESH_ACTION as any });
        } catch (e) {
            logger.error("Failed to refresh messages", e);
        }

        for (const store of storesToRefresh) {
            try {
                store?.emitChange?.();
            } catch (e) {
                logger.error("Failed to refresh store", store?.getName?.(), e);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Adding and removing users
// ---------------------------------------------------------------------------

export function addUser(user: Pick<User, "id" | "username">) {
    if (user.id === UserStore.getCurrentUser()?.id) return;

    settings.store.users = {
        ...settings.store.users,
        [user.id]: { username: user.username, addedAt: Date.now() }
    };

    refresh();
    if (settings.store.muteInVoice) applyMute(user.id);

    showToast(`${user.username} is now truly ignored`, Toasts.Type.SUCCESS);
}

export function removeUser(userId: string) {
    const entry = settings.store.users[userId];
    if (!entry) return;

    revertMute(userId);

    const { [userId]: _, ...rest } = settings.store.users;
    settings.store.users = rest;

    refresh();
    showToast(`${entry.username} is no longer truly ignored`, Toasts.Type.MESSAGE);
}

// ---------------------------------------------------------------------------
// Local voice mute
// ---------------------------------------------------------------------------

function updateEntry(userId: string, patch: Partial<IgnoredUser>) {
    const entry = settings.store.users[userId];
    if (!entry) return;
    settings.store.users = { ...settings.store.users, [userId]: { ...entry, ...patch } };
}

function applyMute(userId: string) {
    runOutsideDispatch(() => {
        try {
            const patch: Partial<IgnoredUser> = {};

            if (!MediaEngineStore.isLocalMute(userId, "default" as any)) {
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_MUTE", context: "default", userId });
                patch.mutedByUs = true;
            }

            if (typeof (SoundboardStore as any)?.isLocalSoundboardMuted === "function" && !(SoundboardStore as any).isLocalSoundboardMuted(userId)) {
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });
                patch.soundboardMutedByUs = true;
            }

            if (Object.keys(patch).length) updateEntry(userId, patch);
        } catch (e) {
            logger.error("Failed to mute", userId, e);
        }
    });
}

function revertMute(userId: string) {
    const entry = settings.store.users[userId];
    if (!entry || (!entry.mutedByUs && !entry.soundboardMutedByUs)) return;

    runOutsideDispatch(() => {
        try {
            if (entry.mutedByUs && MediaEngineStore.isLocalMute(userId, "default" as any))
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_MUTE", context: "default", userId });

            if (entry.soundboardMutedByUs && (SoundboardStore as any)?.isLocalSoundboardMuted?.(userId))
                FluxDispatcher.dispatch({ type: "AUDIO_TOGGLE_LOCAL_SOUNDBOARD_MUTE", userId });

            updateEntry(userId, { mutedByUs: false, soundboardMutedByUs: false });
        } catch (e) {
            logger.error("Failed to unmute", userId, e);
        }
    });
}

function syncAllMutes() {
    if (!running) return;

    for (const id of Object.keys(settings.store.users)) {
        if (settings.store.muteInVoice) applyMute(id);
        else revertMute(id);
    }
}

// ---------------------------------------------------------------------------
// Flux interceptor: stops events from ignored users before any store sees them
// ---------------------------------------------------------------------------

function getDmRecipientId(channel: any): string | undefined {
    if (channel?.type !== CHANNEL_TYPE_DM) return;

    const recipient = channel.recipients?.[0] ?? channel.recipient_ids?.[0] ?? channel.rawRecipients?.[0];
    return typeof recipient === "string" ? recipient : recipient?.id;
}

const INTERCEPTED_EVENTS = new Set([
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "TYPING_START",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "MESSAGE_REACTION_ADD_USERS",
    "RELATIONSHIP_ADD",
    "CHANNEL_CREATE"
]);

function interceptor(event: any): boolean {
    if (!running) return false;

    // Most Flux events are unrelated, so bail out before touching anything else
    if (!INTERCEPTED_EVENTS.has(event.type)) return false;

    try {
        const s = opts;

        switch (event.type) {
            case "MESSAGE_CREATE":
                if (!s.blockLiveMessages || event.optimistic) return false;
                return isAuthoredByHidden(event.message)
                    || (s.replyMode === "hideMessage" && isReplyToHidden(event.message));

            case "MESSAGE_UPDATE":
                return s.blockLiveMessages && isAuthoredByHidden(event.message);

            case "TYPING_START":
                return opts.hideTyping && isHidden(event.userId);

            // Dropping both keeps counts consistent: reactions they add while ignored are never counted
            case "MESSAGE_REACTION_ADD":
            case "MESSAGE_REACTION_REMOVE":
                return s.hideReactions && !event.optimistic && isHidden(event.userId);

            case "MESSAGE_REACTION_ADD_USERS":
                if (s.hideReactions && Array.isArray(event.users))
                    event.users = event.users.filter((u: any) => !isHidden(u?.id));
                return false;

            case "RELATIONSHIP_ADD":
                return s.blockRequests
                    && event.relationship?.type === RELATIONSHIP_PENDING_INCOMING
                    && isHidden(event.relationship.id ?? event.relationship.user?.id);

            // Only message requests. DMs you open yourself also go through CHANNEL_CREATE, and dropping those would break opening them.
            case "CHANNEL_CREATE":
                return s.blockRequests
                    && (event.channel?.is_message_request || event.channel?.isMessageRequest)
                    && isHidden(getDmRecipientId(event.channel));
        }
    } catch (e) {
        logger.error("Interceptor failed on", event?.type, e);
    }

    return false;
}

function addInterceptor() {
    FluxDispatcher.addInterceptor(interceptor);
}

function removeInterceptor() {
    const list: any[] = (FluxDispatcher as any)._interceptors;
    const i = list?.indexOf(interceptor) ?? -1;
    if (i !== -1) list.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Store wrappers: filter what Discord's UI reads from its stores
// ---------------------------------------------------------------------------

const restorers: Array<() => void> = [];

function wrapMethod(store: any, name: string, make: (original: (...args: any[]) => any) => (...args: any[]) => any) {
    const original = store?.[name];
    if (typeof original !== "function") {
        logger.warn(`Could not find ${store?.getName?.() ?? "store"}.${name}, skipping`);
        return;
    }

    const hadOwn = Object.prototype.hasOwnProperty.call(store, name);
    store[name] = make(original.bind(store));

    restorers.push(() => {
        if (hadOwn) store[name] = original;
        else delete store[name];
    });
}

// Results are memoized per input so components that compare snapshots by reference don't re-render in a loop
const memo = new WeakMap<object, { sig: string; out: any; }>();

// Discord's stores hand back the same array until something changes, so the filtered result
// (including "nothing to hide") is cached per array until it or `version` changes.
const listMemo = new WeakMap<object, { v: number; length: number; out: any; }>();

function filterList<T>(list: T[], getUserId: (item: T) => string | undefined | null, enabled: boolean): T[] {
    if (!enabled || !running || !Array.isArray(list) || list.length === 0) return list;

    const cached = listMemo.get(list);
    if (cached?.v === version && cached.length === list.length) return cached.out;

    const out = list.some(item => isHidden(getUserId(item)))
        ? list.filter(item => !isHidden(getUserId(item)))
        : list;

    listMemo.set(list, { v: version, length: list.length, out });
    return out;
}

function filterUserRecord<T>(record: Record<string, T>, enabled: boolean): Record<string, T> {
    if (!enabled || !running || record == null || typeof record !== "object") return record;

    const keys = Object.keys(record);
    if (!keys.some(isHidden)) return record;

    const sig = `${version}:${keys.length}`;
    const cached = memo.get(record);
    if (cached?.sig === sig) return cached.out;

    const out: Record<string, T> = {};
    for (const key of keys) if (!isHidden(key)) out[key] = record[key];

    memo.set(record, { sig, out });
    return out;
}

const participantUserId = (p: any) => p?.user?.id ?? p?.userId;
const sortedVoiceUserId = (v: any) => v?.user?.id ?? v?.voiceState?.userId;
const dmChannelUserId = (channelId: string) => getDmRecipientId(ChannelStore.getChannel(channelId));

// Member list rows are laid out as [group header, ...its members, next group header, ...].
// Remove hidden members and shift every group's count and index to match.
const memberListCache = new Map<string, { key: string; out: any; }>();

function filterMemberList(props: any) {
    if (!running || !opts.hideInMemberList || props == null) return props;

    const { rows, groups } = props;
    if (!Array.isArray(rows) || !Array.isArray(groups)) return props;

    // The list's own version changes whenever a row changes, so check the cache before scanning
    const key = `${props.version}:${version}:${rows.length}`;
    const cached = memberListCache.get(props.listId);
    if (cached?.key === key) return cached.out ?? props;

    const isHiddenRow = (row: any) => row?.type === "MEMBER" && isHidden(row.user?.id);
    if (!rows.some(isHiddenRow)) {
        memberListCache.set(props.listId, { key, out: null });
        return props;
    }

    const groupsByIndex = new Map<number, any>();
    for (const group of groups) groupsByIndex.set(group.index, group);

    const newRows: any[] = [];
    const newGroups: any[] = [];

    for (let i = 0; i < rows.length;) {
        const group = groupsByIndex.get(i);

        if (group == null) {
            if (!isHiddenRow(rows[i])) newRows.push(rows[i]);
            i++;
            continue;
        }

        const members: any[] = [];
        let removed = 0;
        const end = Math.min(i + group.count, rows.length - 1);

        for (let j = i + 1; j <= end; j++) {
            if (isHiddenRow(rows[j])) removed++;
            else members.push(rows[j]);
        }

        const count = Math.max(0, group.count - removed);

        // Drop a group we emptied completely, header included
        if (count > 0 || removed === 0) {
            const index = newRows.length;
            const header = rows[i];

            newGroups.push({ ...group, count, index });
            newRows.push(header?.type === "GROUP" ? { ...header, count, index } : header);
            newRows.push(...members);
        }

        i += group.count + 1;
    }

    const out = { ...props, rows: newRows, groups: newGroups };
    memberListCache.set(props.listId, { key, out });
    return out;
}

function installStoreWrappers() {
    const SortedVoiceStateStore = findStore("SortedVoiceStateStore");
    const ChannelRTCStore = findStore("ChannelRTCStore");
    const PrivateChannelSortStore = findStore("PrivateChannelSortStore");
    const ChannelMemberStore = findStore("ChannelMemberStore");
    ReferencedMessageStore = findStore("ReferencedMessageStore");

    // Messages: Discord already hides "ignored" messages behind a collapsed group, and asks
    // this method everywhere a message is rendered (chat, replies, search, pins, threads).
    wrapMethod(RelationshipStore, "isIgnoredForMessage", original => message => original(message) || shouldHideMessage(message));

    // Typing
    wrapMethod(TypingStore, "getTypingUsers", original => channelId => filterUserRecord(original(channelId), opts.hideTyping));

    // DM list
    wrapMethod(PrivateChannelSortStore, "getPrivateChannelIds", original => () => filterList(original(), dmChannelUserId, opts.hideDMs));
    wrapMethod(PrivateChannelSortStore, "getSortedChannels", original => () => {
        const sections = original();
        if (!Array.isArray(sections)) return sections;

        const filtered = sections.map((section: any[]) => filterList(section, (e: any) => dmChannelUserId(e?.channelId), opts.hideDMs));
        if (filtered.every((section, i) => section === sections[i])) return sections;

        const cached = memo.get(sections);
        const sig = `${version}:${filtered.map(f => f?.length).join(",")}`;
        if (cached?.sig === sig) return cached.out;

        memo.set(sections, { sig, out: filtered });
        return filtered;
    });

    // Member list
    wrapMethod(ChannelMemberStore, "getProps", original => (guildId, channelId) => filterMemberList(original(guildId, channelId)));
    wrapMethod(ChannelMemberStore, "getRows", original => (guildId, channelId) => {
        if (!running || !opts.hideInMemberList) return original(guildId, channelId);
        return ChannelMemberStore.getProps(guildId, channelId).rows;
    });

    // Voice
    const rawVoiceStatesForChannel = VoiceStateStore.getVoiceStatesForChannel.bind(VoiceStateStore);
    wrapMethod(VoiceStateStore, "getVoiceStatesForChannel", original => channelId => filterUserRecord(original(channelId), opts.hideInVoice));
    wrapMethod(VoiceStateStore, "getVideoVoiceStatesForChannel", original => channelId => filterUserRecord(original(channelId), opts.hideInVoice));
    wrapMethod(VoiceStateStore, "getVoiceStates", original => guildId => filterUserRecord(original(guildId), opts.hideInVoice));

    wrapMethod(SortedVoiceStateStore, "getVoiceStatesForChannel", original => channel => filterList(original(channel), sortedVoiceUserId, opts.hideInVoice));
    wrapMethod(SortedVoiceStateStore, "getVoiceStatesForChannelAlt", original => (channelId, guildId) => filterList(original(channelId, guildId), sortedVoiceUserId, opts.hideInVoice));
    wrapMethod(SortedVoiceStateStore, "getVoiceStates", original => guildId => {
        const byChannel = original(guildId);
        if (!running || !opts.hideInVoice || byChannel == null) return byChannel;

        let changed = false;
        const out: Record<string, any[]> = {};
        for (const channelId in byChannel) {
            out[channelId] = filterList(byChannel[channelId], sortedVoiceUserId, true);
            if (out[channelId] !== byChannel[channelId]) changed = true;
        }
        if (!changed) return byChannel;

        const sig = `${version}:${Object.values(out).map(v => v.length).join(",")}`;
        const cached = memo.get(byChannel);
        if (cached?.sig === sig) return cached.out;

        memo.set(byChannel, { sig, out });
        return out;
    });
    wrapMethod(SortedVoiceStateStore, "countVoiceStatesForChannel", original => channelId => {
        const count = original(channelId);
        if (!running || !opts.hideInVoice) return count;

        const hiddenCount = Object.keys(rawVoiceStatesForChannel(channelId) ?? {}).filter(isHidden).length;
        return Math.max(0, count - hiddenCount);
    });

    for (const name of ["getParticipants", "getSpeakingParticipants", "getFilteredParticipants", "getVideoParticipants", "getStreamParticipants"]) {
        wrapMethod(ChannelRTCStore, name, original => channelId => filterList(original(channelId), participantUserId, opts.hideInVoice));
    }

    storesToRefresh = [
        RelationshipStore,
        // Mention pills read the user from here, so this re-renders them
        UserStore,
        TypingStore,
        PrivateChannelSortStore,
        ChannelMemberStore,
        VoiceStateStore,
        SortedVoiceStateStore,
        ChannelRTCStore
    ];
}

function uninstallStoreWrappers() {
    while (restorers.length) {
        try {
            restorers.pop()!();
        } catch (e) {
            logger.error("Failed to restore store method", e);
        }
    }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

interface UserContextProps {
    channel?: Channel;
    guildId?: string;
    user?: User;
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;

    const ignored = isTrulyIgnored(user.id);

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem
            id="vc-true-ignore"
            label={ignored ? "Remove True Ignore" : "True Ignore"}
            color={ignored ? undefined : "danger"}
            action={() => ignored ? removeUser(user.id) : addUser(user)}
        />
    );
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
    name: "TrueIgnore",
    description: "An ignore that actually hides people: their messages, DMs, typing, reactions, member list entry and voice presence disappear, and you can mute them in voice",
    authors: [{ name: "aattiaibrahim", id: 0n }],
    tags: ["Privacy", "Chat", "Friends", "Voice"],
    settings,

    patches: [
        {
            // Lets refresh() make MessageStore recompute which cached messages are ignored
            find: '"MessageStore"',
            replacement: {
                match: /RELATIONSHIP_UPDATE:(\i)/,
                replace: `$&,${REFRESH_ACTION}:$1`
            }
        },
        {
            find: ".__invalid_blocked,",
            replacement: [
                {
                    // Collapsed "N ignored messages" group in the chat: remove it when it only holds truly ignored messages
                    match: /let{messages:\i,[^}]*?collapsedReason[^}]*}/,
                    replace: "if($self.shouldHideGroup(arguments[0]))return null;$&"
                },
                {
                    // Reply preview above someone else's reply to an ignored user
                    match: /replyMessage:(\i),[^}]*?showReplySpine:\i=!0}=\i;/,
                    replace: "$&if($self.shouldHideReplyPreview($1))return null;"
                }
            ]
        },
        {
            // @mentions of them: reuse Discord's pill for unknown users (no popout, no context menu) with a generic name
            find: ".USER_MENTION)",
            replacement: {
                match: /if\(null==(\i)\)return\(0,(\i\.jsx)\)\((\i),\{userId:(\i),className:(\i),children:(\i)\}\)/,
                replace: "if(null==$1||$self.shouldAnonymizeMention($1))return(0,$2)($3,$self.shouldAnonymizeMention($1)?{userId:null,className:$5,children:$self.mentionPlaceholder()}:{userId:$4,className:$5,children:$6})"
            }
        },
        {
            // Single message previews (pins, inbox, search results): hide instead of "1 ignored message"
            find: "count:1,collapsedReason:",
            replacement: {
                match: /(?=\(\i\.\i\.isBlockedForMessage\((\i)\)\?)/,
                replace: "$self.shouldHideMessage($1)?null:"
            }
        }
    ],

    contextMenus: {
        "user-context": userContextPatch
    },

    shouldHideMessage,

    shouldAnonymizeMention(user?: User | null) {
        return running && opts.anonymizeMentions && isHidden(user?.id);
    },

    mentionPlaceholder() {
        return opts.mentionPlaceholder;
    },

    shouldHideGroup(props: any): boolean {
        try {
            const items = props?.messages?.content;
            if (!running || !Array.isArray(items)) return false;

            let sawMessage = false;
            for (const item of items) {
                if (item?.type !== "MESSAGE" && item?.type !== "THREAD_STARTER_MESSAGE") continue;
                if (!shouldHideMessage(item.content)) return false;
                sawMessage = true;
            }

            return sawMessage;
        } catch (e) {
            logger.error("shouldHideGroup failed", e);
            return false;
        }
    },

    shouldHideReplyPreview(replyMessage: any): boolean {
        try {
            if (!running || opts.replyMode !== "hidePreview") return false;
            return isHidden(replyMessage?.message?.author?.id);
        } catch (e) {
            logger.error("shouldHideReplyPreview failed", e);
            return false;
        }
    },

    start() {
        running = true;
        syncOptions();
        // Catches every option, including the ones without an onChange
        SettingsStore.addPrefixChangeListener("plugins.TrueIgnore", syncOptions);
        RelationshipStore.addChangeListener(onRelationshipsChange);

        installStoreWrappers();
        addInterceptor();
        syncAllMutes();
        refresh();
    },

    stop() {
        for (const id of Object.keys(settings.store.users)) revertMute(id);

        removeInterceptor();
        uninstallStoreWrappers();
        SettingsStore.removePrefixChangeListener("plugins.TrueIgnore", syncOptions);
        RelationshipStore.removeChangeListener(onRelationshipsChange);
        running = false;

        // Recompute Discord's ignored flags without us, so hidden messages come back
        refresh();
    }
});

// Runs even while the plugin is waiting to start, so turning it on or off prompts for a reload
watchForToggle(isRunning);
