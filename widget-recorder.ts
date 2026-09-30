/** Records `ctx.ui.setWidget` calls as readable events, e.g. `show: Running wt land` and `hide`. */
export function recordWidgets(events: string[] = []) {
  const theme = { fg: (_color: string, text: string) => text };
  return {
    events,
    setWidget(key: string, content: unknown) {
      if (key !== "pi-worktrunk-progress") return;
      if (content === undefined) {
        events.push("hide");
        return;
      }
      const component = (content as (tui: unknown, theme: unknown) => any)({ requestRender() {} }, theme);
      try {
        const text = component.render(80).join("").trim().replace(/^[\u2800-\u28ff]\s*/, "");
        events.push(`show: ${text}`);
      } finally { component.dispose?.(); }
    },
  };
}
