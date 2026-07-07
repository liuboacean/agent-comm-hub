import React, { useEffect, useState } from 'react';
import {
  Grid, Card, CardContent, Typography, CircularProgress, Box, Chip, List, ListItem, ListItemText,
} from '@mui/material';
import StorageIcon from '@mui/icons-material/Storage';
import WifiIcon from '@mui/icons-material/Wifi';
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety';
import WarningIcon from '@mui/icons-material/Warning';
import { fetchStatus } from '../api';

function HealthPanel(): React.ReactElement {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchStatus>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await fetchStatus();
        setStatus(s);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>健康检查 / FTS5 / DB</Typography>
      <Grid container spacing={3}>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <HealthAndSafetyIcon sx={{ mr: 1, color: status?.health.fts5 === 'consistent' ? '#16a34a' : '#dc2626' }} />
                <Typography variant="h6">FTS5 索引</Typography>
              </Box>
              <Chip label={status?.health.fts5 === 'consistent' ? '✅ 一致' : '❌ 异常'}
                color={status?.health.fts5 === 'consistent' ? 'success' : 'error'} size="small" />
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <StorageIcon sx={{ mr: 1, color: '#0891b2' }} />
                <Typography variant="h6">SSE 连接</Typography>
              </Box>
              <Typography variant="h4" sx={{ fontWeight: 600 }}>{status?.health.active_sse ?? 0}</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={4}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <WifiIcon sx={{ mr: 1, color: '#7c3aed' }} />
                <Typography variant="h6">面板连接</Typography>
              </Box>
              <Typography variant="h4" sx={{ fontWeight: 600 }}>✅</Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12}>
          <Card>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <WarningIcon sx={{ mr: 1, color: '#f59e0b' }} />
                <Typography variant="h6">限流 Top 来源</Typography>
              </Box>
              {(!status?.top_limited || status.top_limited.length === 0) ? (
                <Typography variant="body2" color="text.secondary">暂无限流事件</Typography>
              ) : (
                <List dense>
                  {status.top_limited.map((item) => (
                    <ListItem key={item.agent_id} disablePadding>
                      <ListItemText primary={item.agent_id} secondary={`${item.count} 次`} />
                    </ListItem>
                  ))}
                </List>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}

export default HealthPanel;
