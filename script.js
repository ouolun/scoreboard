const MIN_SCORE = 0;
const SWIPE_THRESHOLD = 30;
const STORAGE_KEY = "scoreboard-state";
const APP_ASSETS = ["index.html", "script.js", "style.css", "manifest.webmanifest", "sw.js"];

const matchSettings = {
    winningScore: 21,
    deuceEnabled: true,
};

let hasAnnouncedWinner = false;
let lastScoringSide = null;
let consecutiveScoreCount = 0;
let serveSwitchTimerId = null;
let activeServeSwitchPanel = null;

function isIOSDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function resolveAppVersion() {
    try {
        const responses = await Promise.all(
            APP_ASSETS.map((asset) => fetch(asset, { method: "HEAD", cache: "no-store" }).catch(() => null))
        );
        const modifiedTimes = responses
            .map((response) => {
                if (!response) {
                    return Number.NaN;
                }

                return Date.parse(response.headers.get("Last-Modified") || "");
            })
            .filter((time) => Number.isFinite(time));

        if (modifiedTimes.length > 0) {
            return new Date(Math.max(...modifiedTimes)).toISOString().slice(0, 10);
        }
    } catch {
        // Fall back to the current date when file metadata is unavailable.
    }

    return new Date().toISOString().slice(0, 10);
}

function updateRotateOverlay() {
    const rotateOverlay = document.querySelector("#rotate-overlay");

    if (!rotateOverlay) {
        return;
    }

    const shouldShow = isIOSDevice() && window.matchMedia("(orientation: portrait)").matches;

    rotateOverlay.classList.toggle("open", shouldShow);
    rotateOverlay.setAttribute("aria-hidden", String(!shouldShow));
}

async function attemptLandscapeLock() {
    if (!screen.orientation || typeof screen.orientation.lock !== "function") {
        return;
    }

    try {
        await screen.orientation.lock("landscape");
    } catch {
        // iOS and some browsers require a user gesture or do not support orientation locking.
    }
}

function getDefaultState() {
    return {
        scores: {
            left: 0,
            right: 0,
        },
        settings: {
            winningScore: 21,
            deuceEnabled: true,
        },
        courtSwapped: false,
    };
}

function loadState() {
    try {
        const savedState = window.localStorage.getItem(STORAGE_KEY);

        if (!savedState) {
            return getDefaultState();
        }

        const parsedState = JSON.parse(savedState);
        const fallbackState = getDefaultState();

        return {
            scores: {
                left: Number.isFinite(Number.parseInt(parsedState?.scores?.left, 10)) ? Math.max(MIN_SCORE, Number.parseInt(parsedState.scores.left, 10)) : fallbackState.scores.left,
                right: Number.isFinite(Number.parseInt(parsedState?.scores?.right, 10)) ? Math.max(MIN_SCORE, Number.parseInt(parsedState.scores.right, 10)) : fallbackState.scores.right,
            },
            settings: {
                winningScore: Number.isFinite(Number.parseInt(parsedState?.settings?.winningScore, 10)) ? Math.min(99, Math.max(2, Number.parseInt(parsedState.settings.winningScore, 10))) : fallbackState.settings.winningScore,
                deuceEnabled: typeof parsedState?.settings?.deuceEnabled === "boolean" ? parsedState.settings.deuceEnabled : fallbackState.settings.deuceEnabled,
            },
            courtSwapped: Boolean(parsedState?.courtSwapped),
        };
    } catch {
        return getDefaultState();
    }
}

function saveState() {
    const leftNumber = document.querySelector(".left-number");
    const rightNumber = document.querySelector(".right-number");

    const nextState = {
        scores: {
            left: Number.parseInt(leftNumber?.textContent || "0", 10) || 0,
            right: Number.parseInt(rightNumber?.textContent || "0", 10) || 0,
        },
        settings: {
            winningScore: matchSettings.winningScore,
            deuceEnabled: matchSettings.deuceEnabled,
        },
        courtSwapped: document.body.classList.contains("court-swapped"),
    };

    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch {
        // Ignore storage failures in restricted environments.
    }
}

function clampMin(value) {
    return Math.max(MIN_SCORE, value);
}

function animateNumber(numberEl, direction) {
    const upClass = "bump-up";
    const downClass = "bump-down";

    numberEl.classList.remove(upClass, downClass);
    void numberEl.offsetWidth;
    numberEl.classList.add(direction === "up" ? upClass : downClass);

    window.setTimeout(() => {
        numberEl.classList.remove(upClass, downClass);
    }, 180);
}

function clearServeSwitchIndicator() {
    if (serveSwitchTimerId !== null) {
        window.clearTimeout(serveSwitchTimerId);
        serveSwitchTimerId = null;
    }

    if (activeServeSwitchPanel) {
        const indicator = activeServeSwitchPanel.querySelector(".serve-switch-indicator");

        if (indicator) {
            indicator.style.opacity = "0";
            indicator.style.animation = "none";
        }

        activeServeSwitchPanel.classList.remove("serve-switch-active");
        activeServeSwitchPanel = null;
    }
}

function showServeSwitchIndicator(panel) {
    clearServeSwitchIndicator();

    const indicator = panel.querySelector(".serve-switch-indicator");

    panel.classList.add("serve-switch-active");
    activeServeSwitchPanel = panel;

    if (indicator) {
        indicator.style.opacity = "1";
        indicator.style.animation = "serve-switch-spin 900ms linear infinite";
    }

    serveSwitchTimerId = window.setTimeout(() => {
        if (indicator) {
            indicator.style.opacity = "0";
            indicator.style.animation = "none";
        }

        panel.classList.remove("serve-switch-active");

        if (activeServeSwitchPanel === panel) {
            activeServeSwitchPanel = null;
        }

        serveSwitchTimerId = null;
    }, 3000);
}

function setActivePanel(panel) {
    document.querySelectorAll(".score-panel").forEach((item) => {
        item.classList.toggle("invert", item === panel);
    });
}

function getScores() {
    const left = Number.parseInt(document.querySelector(".left-number")?.textContent || "0", 10) || 0;
    const right = Number.parseInt(document.querySelector(".right-number")?.textContent || "0", 10) || 0;
    return { left, right };
}

function hasWinner(left, right) {
    if (matchSettings.deuceEnabled) {
        const reachedTarget = left >= matchSettings.winningScore || right >= matchSettings.winningScore;
        return reachedTarget && Math.abs(left - right) >= 2;
    }

    return left >= matchSettings.winningScore || right >= matchSettings.winningScore;
}

function checkWinner() {
    const { left, right } = getScores();

    if (!hasWinner(left, right)) {
        hasAnnouncedWinner = false;
        return;
    }

    if (hasAnnouncedWinner) {
        return;
    }

    const winnerSide = left > right ? "Left" : "Right";
    hasAnnouncedWinner = true;
    window.alert(`${winnerSide} wins!`);
}

function resetScores() {
    const leftNumber = document.querySelector(".left-number");
    const rightNumber = document.querySelector(".right-number");

    if (leftNumber) {
        leftNumber.textContent = "0";
    }

    if (rightNumber) {
        rightNumber.textContent = "0";
    }

    const leftTag = document.querySelector(".left .score-tag");
    const rightTag = document.querySelector(".right .score-tag");

    if (leftTag) {
        leftTag.textContent = "HOST";
    }

    if (rightTag) {
        rightTag.textContent = "GUEST";
    }

    document.querySelectorAll(".score-panel").forEach((panel) => {
        panel.classList.remove("invert");
    });

    document.body.classList.remove("court-swapped");

    clearServeSwitchIndicator();
    lastScoringSide = null;
    consecutiveScoreCount = 0;

    hasAnnouncedWinner = false;
    saveState();
    updateServeIndicators();
}

function swapScores() {
    const leftNumber = document.querySelector(".left-number");
    const rightNumber = document.querySelector(".right-number");
    const leftPanel = document.querySelector(".left.score-panel");
    const rightPanel = document.querySelector(".right.score-panel");
    const leftTag = document.querySelector(".left .score-tag");
    const rightTag = document.querySelector(".right .score-tag");

    if (!leftNumber || !rightNumber || !leftPanel || !rightPanel || !leftTag || !rightTag) {
        return;
    }

    clearServeSwitchIndicator();
    lastScoringSide = null;
    consecutiveScoreCount = 0;

    document.body.classList.toggle("court-swapped");

    leftPanel.classList.add("swap-transition");
    rightPanel.classList.add("swap-transition");

    const temp = leftNumber.textContent;
    leftNumber.textContent = rightNumber.textContent;
    rightNumber.textContent = temp;

    const leftHasInvert = leftPanel.classList.contains("invert");
    const rightHasInvert = rightPanel.classList.contains("invert");

    leftPanel.classList.toggle("invert", rightHasInvert);
    rightPanel.classList.toggle("invert", leftHasInvert);

    const leftTagText = leftTag.textContent;
    leftTag.textContent = rightTag.textContent;
    rightTag.textContent = leftTagText;

    window.setTimeout(() => {
        leftPanel.classList.remove("swap-transition");
        rightPanel.classList.remove("swap-transition");
    }, 240);

    saveState();
    updateServeIndicators();
}

function updateScore(panel, numberEl, delta) {
    const current = Number.parseInt(numberEl.textContent, 10) || 0;
    const next = clampMin(current + delta);

    if (next === current) {
        animateNumber(numberEl, "down");
        return;
    }

    numberEl.textContent = String(next);
    animateNumber(numberEl, delta > 0 ? "up" : "down");

    if (delta > 0) {
        setActivePanel(panel);

        const scoringSide = panel.dataset.side || "";

        if (lastScoringSide === scoringSide) {
            consecutiveScoreCount += 1;
        } else {
            lastScoringSide = scoringSide;
            consecutiveScoreCount = 1;
        }

        // --- 修改這裡的邏輯 ---
        if (consecutiveScoreCount >= 2) {
            // 不再將 consecutiveScoreCount 歸零，
            // 這樣後續只要 lastScoringSide 不變，每次都會進來這裡
            showServeSwitchIndicator(panel);
        }
        // ---------------------
    } else {
        lastScoringSide = null;
        consecutiveScoreCount = 0;
    }

    checkWinner();
    saveState();
    updateServeIndicators();
}

function setupPanel(panel) {
    const numberEl = panel.querySelector(".left-number, .right-number");

    if (!numberEl) {
        return;
    }

    let startY = null;

    panel.addEventListener("pointerdown", (event) => {
        startY = event.clientY;
    });

    panel.addEventListener("pointerup", (event) => {
        if (startY === null) {
            return;
        }

        const deltaY = event.clientY - startY;

        if (deltaY <= -SWIPE_THRESHOLD) {
            updateScore(panel, numberEl, 1);
        } else if (deltaY >= SWIPE_THRESHOLD) {
            updateScore(panel, numberEl, -1);
        }

        startY = null;
    });

    panel.addEventListener("pointercancel", () => {
        startY = null;
    });
}

function setupButtons(appVersion) {
    const menuToggle = document.querySelector("#menu-toggle");
    const actionMenu = document.querySelector("#action-menu");
    const resetBtn = document.querySelector(".reset-btn");
    const settingsBtn = document.querySelector(".settings-btn");
    const swapBtn = document.querySelector(".swap-btn");
    const modal = document.querySelector(".settings-modal");
    const winningInput = document.querySelector("#winning-score");
    const winningScoreUp = document.querySelector("#winning-score-up");
    const winningScoreDown = document.querySelector("#winning-score-down");
    const deuceInput = document.querySelector("#enable-deuce");
    const saveButton = document.querySelector("#save-settings");
    const backdrop = document.querySelector(".settings-backdrop");

    const persistedState = loadState();
    const leftNumber = document.querySelector(".left-number");
    const rightNumber = document.querySelector(".right-number");
    const leftTag = document.querySelector(".left .score-tag");
    const rightTag = document.querySelector(".right .score-tag");

    matchSettings.winningScore = persistedState.settings.winningScore;
    matchSettings.deuceEnabled = persistedState.settings.deuceEnabled;

    if (winningInput) {
        winningInput.value = String(matchSettings.winningScore);
    }

    if (deuceInput) {
        deuceInput.checked = matchSettings.deuceEnabled;
    }

    if (leftNumber) {
        leftNumber.textContent = String(persistedState.scores.left);
    }

    if (rightNumber) {
        rightNumber.textContent = String(persistedState.scores.right);
    }

    if (persistedState.courtSwapped) {
        document.body.classList.add("court-swapped");

        if (leftTag) {
            leftTag.textContent = "GUEST";
        }

        if (rightTag) {
            rightTag.textContent = "HOST";
        }
    }

    hasAnnouncedWinner = hasWinner(persistedState.scores.left, persistedState.scores.right);

    if (!menuToggle || !actionMenu || !resetBtn || !settingsBtn || !swapBtn || !winningInput || !winningScoreUp || !winningScoreDown || !deuceInput) {
        return;
    }

    const clampWinningScore = (value) => Math.min(99, Math.max(2, value));

    const syncWinningScore = (value) => {
        const nextValue = clampWinningScore(value);
        winningInput.value = String(nextValue);
        return nextValue;
    };

    const closeModal = () => {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
    };

    const closeMenu = () => {
        actionMenu.classList.remove("open");
        actionMenu.setAttribute("aria-hidden", "true");
        menuToggle.setAttribute("aria-expanded", "false");
    };

    const toggleMenu = () => {
        const isOpen = actionMenu.classList.toggle("open");
        actionMenu.setAttribute("aria-hidden", String(!isOpen));
        menuToggle.setAttribute("aria-expanded", String(isOpen));
    };

    const openModal = () => {
        closeMenu();
        winningInput.value = String(matchSettings.winningScore);
        deuceInput.checked = matchSettings.deuceEnabled;
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
    };

    menuToggle.addEventListener("click", toggleMenu);

    winningScoreUp.addEventListener("click", () => {
        const currentValue = Number.parseInt(winningInput.value, 10) || 2;
        syncWinningScore(currentValue + 1);
    });

    winningScoreDown.addEventListener("click", () => {
        const currentValue = Number.parseInt(winningInput.value, 10) || 2;
        syncWinningScore(currentValue - 1);
    });

    winningInput.addEventListener("input", () => {
        if (winningInput.value === "") {
            return;
        }

        const currentValue = Number.parseInt(winningInput.value, 10);

        if (!Number.isNaN(currentValue)) {
            syncWinningScore(currentValue);
        }
    });

    winningInput.addEventListener("blur", () => {
        const currentValue = Number.parseInt(winningInput.value, 10);
        syncWinningScore(Number.isFinite(currentValue) ? currentValue : matchSettings.winningScore);
        saveState();
    });

    resetBtn.addEventListener("click", () => {
        resetScores();
        closeMenu();
    });

    settingsBtn.addEventListener("click", openModal);

    swapBtn.addEventListener("click", () => {
        swapScores();
        closeMenu();
    });

    backdrop.addEventListener("click", closeModal);

    if (saveButton) {
        saveButton.addEventListener("click", () => {
            const nextWinningScore = Number.parseInt(winningInput.value, 10);
            matchSettings.winningScore = Number.isFinite(nextWinningScore) ? clampWinningScore(nextWinningScore) : 21;
            matchSettings.deuceEnabled = deuceInput.checked;
            hasAnnouncedWinner = false;
            checkWinner();
            saveState();
            closeModal();
        });
    }

    const cancelBtn = document.querySelector(".btn.cancel");
    if (cancelBtn) {
        cancelBtn.addEventListener("click", closeModal);
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal.classList.contains("open")) {
            closeModal();
            return;
        }

        if (event.key === "Escape" && actionMenu.classList.contains("open")) {
            closeMenu();
        }
    });

    document.addEventListener("click", (event) => {
        if (!actionMenu.classList.contains("open")) {
            return;
        }

        if (event.target.closest(".menu-shell")) {
            return;
        }

        closeMenu();
    });

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(appVersion)}`).then((registration) => {
                if (typeof registration.update === "function") {
                    registration.update().catch(() => {
                        // Ignore update check failures in restricted environments.
                    });
                }
            }).catch(() => {
                // Ignore registration failures in unsupported or file:// environments.
            });

            navigator.serviceWorker.addEventListener("controllerchange", () => {
                window.location.reload();
            });
        });
    }
}

function setupServeIndicators() {
    const styles = document.createElement("style");
    styles.textContent = `
        .serve-indicator {
            position: fixed;
            width: 72px;
            height: 72px;
            background: white;
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 40px;
            box-shadow: 0 0 10px rgba(0,0,0,0.3);
            opacity: 0;
            transition: opacity 0.3s ease;
            z-index: 1000;
            pointer-events: none;
        }
        .serve-indicator.active {
            opacity: 1;
        }
        #serve-indicator-left-top { top: 24px; left: 24px; }
        #serve-indicator-left-bottom { bottom: 24px; left: 24px; }
        #serve-indicator-right-top { top: 24px; right: 24px; }
        #serve-indicator-right-bottom { bottom: 24px; right: 24px; }
    `;
    document.head.appendChild(styles);

    const positions = ["left-top", "left-bottom", "right-top", "right-bottom"];
    positions.forEach(pos => {
        const el = document.createElement("div");
        el.id = `serve-indicator-${pos}`;
        el.className = "serve-indicator";
        el.textContent = "🏸";
        document.body.appendChild(el);
    });
}

function updateServeIndicators() {
    document.querySelectorAll(".serve-indicator").forEach(el => el.classList.remove("active"));

    if (!lastScoringSide) return;

    const { left, right } = getScores();

    // 假設左半邊隊伍面向右：其右方選手在下方，左方選手在上方
    // 假設右半邊隊伍面向左：其右方選手在上方，左方選手在下方
    if (lastScoringSide === "left") {
        const isEven = left % 2 === 0;
        document.getElementById(isEven ? "serve-indicator-left-bottom" : "serve-indicator-left-top")?.classList.add("active");
    } else if (lastScoringSide === "right") {
        const isEven = right % 2 === 0;
        document.getElementById(isEven ? "serve-indicator-right-top" : "serve-indicator-right-bottom")?.classList.add("active");
    }
}

async function bootstrap() {
    const appVersion = await resolveAppVersion();
    setupServeIndicators();
    document.querySelectorAll(".score-panel").forEach(setupPanel);
    setupButtons(appVersion);
    updateRotateOverlay();

    window.addEventListener("resize", updateRotateOverlay);
    window.addEventListener("orientationchange", updateRotateOverlay);
    window.addEventListener("pointerdown", attemptLandscapeLock, { once: true });
    window.addEventListener("load", attemptLandscapeLock, { once: true });
}

bootstrap();
