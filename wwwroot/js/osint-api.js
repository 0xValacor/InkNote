// ── Investigation CRUD ───────────────────────────────────────────────────────

export async function getInvestigations() {
  return (await fetch('/api/investigations')).json();
}

export async function createInvestigation(name, description = null) {
  return (await fetch('/api/investigations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  })).json();
}

export async function getInvestigation(id) {
  return (await fetch(`/api/investigations/${id}`)).json();
}

export async function renameInvestigation(id, name) {
  return (await fetch(`/api/investigations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })).json();
}

export async function deleteInvestigation(id) {
  await fetch(`/api/investigations/${id}`, { method: 'DELETE' });
}

export async function getInvestigationDrawing(id) {
  return (await fetch(`/api/investigations/${id}/drawing`)).json();
}

export async function saveInvestigationDrawing(id, compressedData) {
  await fetch(`/api/investigations/${id}/drawing`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compressedData })
  });
}

// ── Entity CRUD ──────────────────────────────────────────────────────────────

export async function addEntity(invId, type, label, x = 0, y = 0, notes = null) {
  return (await fetch(`/api/investigations/${invId}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, label, x, y, notes })
  })).json();
}

export async function updateEntity(invId, entityId, updates) {
  return (await fetch(`/api/investigations/${invId}/entities/${entityId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  })).json();
}

export async function deleteEntity(invId, entityId) {
  await fetch(`/api/investigations/${invId}/entities/${entityId}`, { method: 'DELETE' });
}

// ── Relation CRUD ────────────────────────────────────────────────────────────

export async function addRelation(invId, sourceId, targetId, label = null) {
  return (await fetch(`/api/investigations/${invId}/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, targetId, label })
  })).json();
}

export async function deleteRelation(invId, relationId) {
  await fetch(`/api/investigations/${invId}/relations/${relationId}`, { method: 'DELETE' });
}

// ── OSINT queries ────────────────────────────────────────────────────────────

export async function osintDns(target) {
  return (await fetch(`/api/osint/dns?target=${encodeURIComponent(target)}`)).json();
}

export async function osintSubdomains(domain) {
  return (await fetch(`/api/osint/subdomains?domain=${encodeURIComponent(domain)}`)).json();
}

export async function osintWhois(target) {
  return (await fetch(`/api/osint/whois?target=${encodeURIComponent(target)}`)).json();
}

export async function osintIp(target) {
  return (await fetch(`/api/osint/ip?target=${encodeURIComponent(target)}`)).json();
}

export async function osintShodan(target) {
  return (await fetch(`/api/osint/shodan?target=${encodeURIComponent(target)}`)).json();
}

export async function osintHibp(email) {
  return (await fetch(`/api/osint/hibp?email=${encodeURIComponent(email)}`)).json();
}

export async function osintUsernames(username) {
  return (await fetch(`/api/osint/usernames?username=${encodeURIComponent(username)}`)).json();
}
