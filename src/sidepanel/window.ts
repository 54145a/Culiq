/** The browser window that hosts this panel (side panel or pop-up window). */
let panelWindowId: number | undefined;

export function setPanelWindowId(id: number | undefined): void {
	panelWindowId = id;
}

export function getPanelWindowId(): number | undefined {
	return panelWindowId;
}
