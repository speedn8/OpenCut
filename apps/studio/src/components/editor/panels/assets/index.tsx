"use client";

import { Separator } from "@/components/ui/separator";
import { type Tab, useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { TabBar } from "./tabbar";
import { MediaView } from "./views/assets";
import { SettingsView } from "./views/settings";
import { TextView } from "@/text/components/assets-view";
import { EffectsView } from "@/effects/components/assets-view";
import { useEditor } from "@/editor/use-editor";

export function AssetsPanel() {
	const { activeTab } = useAssetsPanelStore();
	const degraded = useEditor((editor) => editor.renderer.isDegraded);
	const unavailable = <div className="text-muted-foreground p-4 text-sm">This tool is unavailable in this local edition.</div>;

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: unavailable,
		text: <TextView />,
		stickers: unavailable,
		effects: degraded ? <div className="text-muted-foreground p-4 text-sm">GPU effects are unavailable on this device.</div> : <EffectsView />,
		transitions: (
			<div className="text-muted-foreground p-4">
				Transitions view coming soon...
			</div>
		),
		captions: unavailable,
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
