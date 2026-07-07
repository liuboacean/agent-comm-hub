import React, { useState } from 'react';
import { Box, Card, CardContent, TextField, Button, Typography, Alert } from '@mui/material';

interface LoginGuardProps {
  role: string | null;
  onLogin: (role: string) => void;
  children: React.ReactElement;
}

function LoginGuard({ role, onLogin, children }: LoginGuardProps): React.ReactElement {
  const [inputRole, setInputRole] = useState('admin');
  const [error, setError] = useState<string | null>(null);

  if (role) return children;

  const handleLogin = () => {
    const trimmed = inputRole.trim().toLowerCase();
    const valid = ['admin', 'member', 'peer', 'guest'];
    if (!valid.includes(trimmed)) {
      setError('无效角色。可选: admin, member, peer, guest');
      return;
    }
    onLogin(trimmed);
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Card sx={{ maxWidth: 400, width: '100%', mx: 2 }}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" sx={{ mb: 1, fontWeight: 600, textAlign: 'center' }}>ACH Console</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3, textAlign: 'center' }}>Agent-Comm-Hub 管理面板</Typography>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <TextField fullWidth label="角色" value={inputRole} onChange={(e) => setInputRole(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()} sx={{ mb: 2 }} size="small" />
          <Button fullWidth variant="contained" onClick={handleLogin} sx={{ textTransform: 'none' }}>进入面板</Button>
        </CardContent>
      </Card>
    </Box>
  );
}

export default LoginGuard;
