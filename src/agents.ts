// エージェント名 → ロール。新エージェントが追加されたらここに足す（未登録は「不明」扱いになるだけで動作はする）。

export type Role = "duelist" | "initiator" | "controller" | "sentinel";

export const ROLE_LABEL: Record<Role, string> = {
  duelist: "デュエリスト",
  initiator: "イニシエーター",
  controller: "コントローラー",
  sentinel: "センチネル",
};

const BY_ROLE: Record<Role, string[]> = {
  duelist: ["Jett", "Phoenix", "Reyna", "Raze", "Yoru", "Neon", "Iso", "Waylay", "Hush"],
  initiator: ["Sova", "Breach", "Skye", "KAY/O", "Fade", "Gekko", "Tejo"],
  controller: ["Brimstone", "Viper", "Omen", "Astra", "Harbor", "Clove", "Miks"],
  sentinel: ["Killjoy", "Cypher", "Sage", "Chamber", "Deadlock", "Vyse", "Veto"],
};

const ROLE_OF = new Map<string, Role>();
for (const [role, names] of Object.entries(BY_ROLE) as [Role, string[]][]) {
  for (const n of names) ROLE_OF.set(n.toLowerCase(), role);
}

export const roleOf = (agent: string | null | undefined): Role | null =>
  (agent && ROLE_OF.get(agent.toLowerCase())) || null;
