# Model Picker Add to Settings Design

## Goal

Make the **Add** button in the agent `/model` picker close the picker and open the Settings modal directly on the Models tab.

## Design

`SettingsModal` will accept an optional `initialTab: SettingsTab` prop. When omitted, it will continue to open on General. The agent model picker callback will close its attached panel and then call:

```ts
modalsModel.pushModal("SettingsModal", { initialTab: "models" });
```

This keeps tab selection local to Settings and reuses the existing modal property channel. It avoids global navigation state and DOM-driven tab selection.

## Interaction

1. The user opens `/model` in the agent composer.
2. The user clicks **Add**.
3. The `/model` picker closes.
4. Settings opens with the Models tab active.
5. Opening Settings from the top bar without an initial tab still shows General.

## Testing

- Verify `SettingsModal` defaults to General.
- Verify `SettingsModal initialTab="models"` renders Models as the selected tab.
- Verify the agent model picker Add action closes the picker and pushes `SettingsModal` with `{ initialTab: "models" }`.

## Scope

No changes are made to provider configuration behavior, model selection, or the other model-picker entry points.
