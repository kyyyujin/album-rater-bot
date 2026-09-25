-- Cover Phase 4B foreign-key lookup paths identified by the database advisor.
create index vault_cosmetic_entitlements_definition_fk_idx
  on public.vault_cosmetic_entitlements(source_achievement_key);
create index vault_cosmetic_entitlements_unlock_fk_idx
  on public.vault_cosmetic_entitlements(source_unlock_id);
create index vault_cosmetic_state_entitlement_fk_idx
  on public.vault_cosmetic_state(user_id,equipped_key);
