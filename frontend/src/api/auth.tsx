import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api, setToken, clearToken } from "./client";

type User = { id: number; username: string; role: string; display_name: string | null; avatar_url: string | null };

const AuthContext = createContext<{
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
  updateProfile: (payload: { display_name?: string | null; avatar_url?: string | null }) => Promise<User>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string): Promise<User> => {
    const { access_token } = await api.auth.login(username, password);
    setToken(access_token);
    const me = await api.auth.me();
    const u = me as User;
    setUser(u);
    return u;
  };

  const logout = () => {
    clearToken();
    setUser(null);
  };

  const updateProfile = async (payload: { display_name?: string | null; avatar_url?: string | null }): Promise<User> => {
    const updated = await api.auth.updateProfile(payload);
    const next = updated as User;
    setUser(next);
    return next;
  };

  const changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
    await api.auth.changePassword({ current_password: currentPassword, new_password: newPassword });
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, updateProfile, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
