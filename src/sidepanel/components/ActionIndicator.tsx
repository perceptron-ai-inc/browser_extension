interface ActionIndicatorProps {
  text: string;
}

export function ActionIndicator({ text }: ActionIndicatorProps) {
  return (
    <div class="action-indicator">
      <div class="spinner" />
      <span class="action-text">{text}</span>
    </div>
  );
}
