-- supabase.sql — Ejecuta esto en el editor SQL de Supabase para crear las tablas.

-- Historial de mensajes
create table if not exists mensajes (
  id bigint generated always as identity primary key,
  telefono text not null,
  rol text not null check (rol in ('user', 'assistant')),
  contenido text not null,
  created_at timestamptz default now()
);
create index if not exists idx_mensajes_telefono on mensajes (telefono, created_at);

-- Estado de cada conversación (¿la maneja el humano?)
create table if not exists conversaciones (
  telefono text primary key,
  requiere_humano boolean default false,
  actualizado timestamptz default now()
);
