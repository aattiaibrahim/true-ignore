/*
 * TrueIgnore, a Vencord user plugin
 * Copyright (c) 2026 aattiaibrahim
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotice } from "@api/Notices";
import { SettingsStore } from "@api/Settings";
import { ConfirmModal, openModal } from "@webpack/common";

// Vencord only starts or stops a plugin with patches on the next reload, so TrueIgnore
// does nothing until Discord reloads. Ask for that reload as soon as the toggle changes.

let bannerShown = false;

export function reloadDiscord() {
    location.reload();
}

/** Whether the plugin's on/off switch no longer matches what's actually running */
export function isReloadPending(started: boolean) {
    return !!SettingsStore.plain.plugins?.TrueIgnore?.enabled !== started;
}

function showBanner(enabling: boolean) {
    if (bannerShown) return;
    bannerShown = true;

    showNotice(
        enabling
            ? "TrueIgnore won't hide anyone until Discord reloads."
            : "TrueIgnore keeps hiding people until Discord reloads.",
        "Reload now",
        reloadDiscord
    );
}

function promptReload(enabling: boolean) {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Reload Discord?"
            confirmText="Reload now"
            cancelText="Later"
            variant="primary"
            onConfirm={reloadDiscord}
            onCancel={() => showBanner(enabling)}
        >
            <p>
                {enabling
                    ? "TrueIgnore needs Discord to reload before it can start hiding people."
                    : "TrueIgnore needs Discord to reload before it turns off. Until then, people you've ignored stay hidden."}
            </p>
        </ConfirmModal>
    ));
}

export function watchForToggle(isStarted: () => boolean) {
    SettingsStore.addChangeListener("plugins.TrueIgnore.enabled", (enabled: boolean) => {
        if (!!enabled !== isStarted()) promptReload(!!enabled);
    });
}
