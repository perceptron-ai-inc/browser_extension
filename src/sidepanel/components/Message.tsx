interface MessageProps {
  content: string;
  type: "user" | "assistant";
  role?: "reasoning" | "action";
}

function getRoleLabel(role?: string): string | null {
  switch (role) {
    case "reasoning":
      return "🧠 Reasoning";
    case "action":
      return "⚡ Action";
    default:
      return null;
  }
}

export function Message({ content, type, role }: MessageProps) {
  const roleLabel = getRoleLabel(role);

  return (
    <div class={`message ${type}`}>
      {roleLabel && <div class={`message-role ${role}`}>{roleLabel}</div>}
      <div class="message-content">{content}</div>
    </div>
  );
}
