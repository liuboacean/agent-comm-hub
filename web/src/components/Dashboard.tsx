import React, { useEffect, useState, useCallback } from 'react';
import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import TimelineIcon from '@mui/icons-material/Timeline';
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety';
import { fetchStatus, fetchAuditTail, type StatusData, type AuditEntry } from '../api';

const POLL_MS = 5000;

function Dashboard(): React.ReactElement {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await fetchStatus();
      setStatus(s);
      setError(null);
    } catch {
      setError('无法加载指标数据');
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const entries = await fetchAuditTail(8);
      setAuditEntries(entries);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    load();
    loadAudit();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load, loadAudit]);

  if (!status) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>Dashboard 总览</Typography>

      {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}

      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">在线 Agent</Typography>
                  <Typography variant="h4" sx={{ fontWeight: 600 }}>{status.agents.online} / {status.agents.total}</Typography>
                </Box>
                <PeopleIcon sx={{ fontSize: 40, color: '#4f46e5', opacity: 0.7 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">Pipeline 状态</Typography>
                  <Typography variant="h4" sx={{ fontWeight: 600 }}>{status.pipelines.total}</Typography>
                </Box>
                <AccountTreeIcon sx={{ fontSize: 40, color: '#7c3aed', opacity: 0.7 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">消息吞吐 / 5m</Typography>
                  <Typography variant="h4" sx={{ fontWeight: 600 }}>{status.throughput.last_5min.toLocaleString()}</Typography>
                </Box>
                <TimelineIcon sx={{ fontSize: 40, color: '#0891b2', opacity: 0.7 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Card sx={{ height: '100%' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">FTS5 健康</Typography>
                  <Typography variant="h4" sx={{ fontWeight: 600, color: status.health.fts5 === 'consistent' ? '#16a34a' : '#dc2626' }}>
                    {status.health.fts5 === 'consistent' ? '✅ 一致' : '⚠️ 异常'}
                  </Typography>
                </Box>
                <HealthAndSafetyIcon sx={{ fontSize: 40, color: status.health.fts5 === 'consistent' ? '#16a34a' : '#dc2626', opacity: 0.7 }} />
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>实时审计流</Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 300 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>时间</TableCell>
                  <TableCell>操作</TableCell>
                  <TableCell>目标</TableCell>
                  <TableCell>操作者</TableCell>
                  <TableCell>结果</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {auditEntries.length === 0 ? (
                  <TableRow><TableCell colSpan={5} align="center">等待审计事件...</TableCell></TableRow>
                ) : (
                  auditEntries.map((e, i) => (
                    <TableRow key={`${e.id}-${i}`}>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{formatTs(e.ts)}</TableCell>
                      <TableCell>{e.action}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{e.target}</TableCell>
                      <TableCell>{e.operator}</TableCell>
                      <TableCell>
                        <Chip label={e.details || 'success'} size="small" variant="outlined"
                          color={e.details?.startsWith('fail') ? 'error' : 'success'} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}

function formatTs(ts: string): string {
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return ts; }
}

export default Dashboard;
