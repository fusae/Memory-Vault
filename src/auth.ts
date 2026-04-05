import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SupabaseClient, Session } from '@supabase/supabase-js';

const SESSION_PATH = path.join(os.homedir(), '.memoryvault', 'session.json');
const CONFIG_PATH = path.join(os.homedir(), '.memoryvault', 'config.json');

export interface MemoryVaultConfig {
  supabase_url?: string;
  supabase_anon_key?: string;
}

export class AuthService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  async sendOtp(email: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        // No emailRedirectTo — forces Supabase to send a 6-digit OTP code instead of a magic link
      },
    });
    if (error) throw new Error(`Failed to send OTP: ${error.message}`);
  }

  async verifyOtp(email: string, token: string): Promise<Session> {
    const { data, error } = await this.supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });
    if (error) throw new Error(`OTP verification failed: ${error.message}`);
    if (!data.session) throw new Error('No session returned');

    this.saveSession(data.session);
    return data.session;
  }

  async getSession(): Promise<Session | null> {
    // Try to restore from file
    const saved = this.loadSession();
    if (!saved) return null;

    // Set the session on the client
    const { data, error } = await this.supabase.auth.setSession({
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
    });

    if (error || !data.session) {
      this.clearSession();
      return null;
    }

    // Persist refreshed tokens
    this.saveSession(data.session);
    return data.session;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
    this.clearSession();
  }

  getUserId(session: Session): string {
    return session.user.id;
  }

  private saveSession(session: Session): void {
    const dir = path.dirname(SESSION_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_PATH, JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      user_id: session.user.id,
      user_email: session.user.email,
    }, null, 2), { mode: 0o600 });
  }

  private loadSession(): { access_token: string; refresh_token: string } | null {
    if (!fs.existsSync(SESSION_PATH)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
      if (data.access_token && data.refresh_token) return data;
      return null;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
  }

  // Config management
  static saveConfig(config: MemoryVaultConfig): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  static loadConfig(): MemoryVaultConfig {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }
}
