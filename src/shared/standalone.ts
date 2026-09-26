/**
 * Shared standalone mode detection. When Culiq runs in a popup window,
 * new tabs should not steal focus (the popup would be hidden).
 */

let popupWindowId: number | undefined;

/** Called by the service worker when a standalone panel opens. */
export function setPopupWindowId(id: number | undefined): void {
	popupWindowId = id;
}

/** Clear standalone mode if the given window ID matches. */
export function clearIfMatches(id: number): void {
	if (id === popupWindowId) popupWindowId = undefined;
}

/** Check if Culiq is currently running in standalone (popup) mode. */
export function isStandaloneMode(): boolean {
	return popupWindowId !== undefined;
}

/** Get the popup window ID (for focusing). */
export function getPopupWindowId(): number | undefined {
	return popupWindowId;
}
