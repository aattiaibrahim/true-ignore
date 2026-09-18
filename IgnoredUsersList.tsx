/*
 * TrueIgnore, a Vencord user plugin
 * Copyright (c) 2026 aattiaibrahim
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { TextInput, UserStore, UserUtils, useState } from "@webpack/common";

import { addUser, isRunning, removeUser, settings } from ".";
import { isReloadPending, reloadDiscord } from "./reloadPrompt";

const SNOWFLAKE = /^\d{17,20}$/;

function IgnoredUserRow({ id, username, addedAt }: { id: string; username: string; addedAt: number; }) {
    const user = UserStore.getUser(id);

    return (
        <div className="vc-true-ignore-row">
            {user
                ? <img className="vc-true-ignore-avatar" src={user.getAvatarURL(void 0, 32, false)} alt="" />
                : <div className="vc-true-ignore-avatar" />}

            <div className="vc-true-ignore-info">
                <Paragraph size="md" weight="medium">{user?.globalName ?? user?.username ?? username}</Paragraph>
                <Paragraph size="xs" className="vc-true-ignore-muted">
                    {user?.username ?? username} · {id} · added {new Date(addedAt).toLocaleDateString()}
                </Paragraph>
            </div>

            <Button variant="dangerSecondary" size="small" onClick={() => removeUser(id)}>
                Remove
            </Button>
        </div>
    );
}

export function IgnoredUsersList() {
    const { users } = settings.use(["users"]);
    const enabled = !!useSettings(["plugins.TrueIgnore.enabled"]).plugins.TrueIgnore?.enabled;
    const reloadPending = isReloadPending(isRunning());
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const entries = Object.entries(users ?? {}).sort(([, a], [, b]) => b.addedAt - a.addedAt);

    async function add() {
        const id = input.trim();
        if (!SNOWFLAKE.test(id)) return setError("That doesn't look like a user ID");
        if (users[id]) return setError("That user is already on the list");
        if (id === UserStore.getCurrentUser()?.id) return setError("You can't ignore yourself");

        setBusy(true);
        setError(null);
        try {
            const user = UserStore.getUser(id) ?? await UserUtils.getUser(id);
            addUser({ id, username: user?.username ?? id });
            setInput("");
        } catch {
            setError("Couldn't find that user");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section>
            {reloadPending && (
                <div className={`vc-true-ignore-reload ${Margins.bottom16}`}>
                    <Paragraph size="sm">
                        {enabled
                            ? "TrueIgnore is on, but it won't hide anyone until Discord reloads."
                            : "TrueIgnore is off, but it keeps hiding people until Discord reloads."}
                    </Paragraph>
                    <Button size="small" onClick={reloadDiscord}>Reload now</Button>
                </div>
            )}

            <BaseText size="md" weight="semibold">Truly ignored users</BaseText>
            <Paragraph size="sm" className={`${Margins.top8} vc-true-ignore-muted`}>
                Right-click anyone and pick "True Ignore", or paste a user ID below.
                Turn off any of the options below to bring that part back without removing anyone.
            </Paragraph>

            <Flex gap="0.5em" className={Margins.top8} alignItems="center">
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={input}
                        placeholder="User ID"
                        onChange={v => { setInput(v); setError(null); }}
                        onKeyDown={e => e.key === "Enter" && add()}
                        error={error ?? undefined}
                    />
                </div>
                <Button onClick={add} disabled={busy || !input.trim()}>Add</Button>
            </Flex>

            <Flex flexDirection="column" gap="0.5em" className={Margins.top16}>
                {entries.length === 0
                    ? <Paragraph size="sm" className="vc-true-ignore-muted">Nobody yet.</Paragraph>
                    : entries.map(([id, entry]) => <IgnoredUserRow key={id} id={id} {...entry} />)}
            </Flex>
        </section>
    );
}
