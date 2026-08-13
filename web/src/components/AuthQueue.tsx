import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip, Typography,
  Box, CircularProgress, Button, TextField, Stack, Tooltip, Snackbar, Alert,
} from '@mui/material';
import {
  fetchAuthRequests, resolveAuthRequest, type AuthRequest, type AuthRequestStatus,
} from '../api';

const STATUS_COLOR: Record<AuthRequestStatus, 'warning' | 'success' | 'error' | 'default'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'error',
  expired: 'default',
};

function formatTs(ts: number): string {
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return String(ts); }
}

function parsePayload(payload?: string | null): string {
  if (!payload) return '-';
  try {
    const obj = JSON.parse(payload);
    return JSON.stringify(obj, null, 2);
  } catch {
    return payload;
  }
}

function AuthQueue(): React.ReactElement {
  const [requests, setRequests] = useState<AuthRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grantWindows, setGrantWindows] = useState<Record<string, string>>({});
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchAuthRequests('pending');
      setRequests(data);
    } catch (err) {
      // 鉴权失败等：静默保留上次数据
      console.error('[AuthQueue] 拉取待授权失败', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 轮询 4s（人类 UI 量级小，不进 Agent 零轮询约束）
  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [load]);

  const handleResolve = async (
    id: string,
    decision: 'approved' | 'rejected'
  ): Promise<void> => {
    setBusyId(id);
    try {
      const grantWindowMs = grantWindows[id];
      await resolveAuthRequest(id, {
        decision,
        reason: decision === 'rejected' ? '由仪表盘人工拒绝' : undefined,
        grant_window_ms:
          decision === 'approved' && grantWindowMs
            ? parseInt(grantWindowMs, 10)
            : undefined,
      });
      setSnack({
        msg: decision === 'approved' ? `已批准 ${id}` : `已拒绝 ${id}`,
        severity: 'success',
      });
      // 立即刷新，移除该项
      await load();
    } catch (err) {
      setSnack({
        msg: err instanceof Error ? err.message : '操作失败',
        severity: 'error',
      });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1, fontWeight: 600 }}>待授权队列</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Agent 执行中遇到敏感操作会在此挂起等待人工批准。拒绝后 Agent 将优雅中止该操作。
      </Typography>

      <TableContainer component={Paper} sx={{ maxHeight: 640 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>状态</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>请求 ID</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Agent</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>操作类目</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>说明</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>参数</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>到期</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">暂无待授权请求</TableCell>
              </TableRow>
            ) : (
              requests.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Chip label={r.status} size="small" color={STATUS_COLOR[r.status]} variant="outlined" />
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.id}</TableCell>
                  <TableCell>{r.agent_id}</TableCell>
                  <TableCell>
                    <Chip label={r.op_type} size="small" color="secondary" variant="outlined" />
                  </TableCell>
                  <TableCell>{r.op_payload ? parsePayload(r.op_payload) : r.op_type}</TableCell>
                  <TableCell>
                    <Tooltip title={r.op_payload ? parsePayload(r.op_payload) : '-'}>
                      <span>{r.op_payload ? '查看' : '-'}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTs(r.expires_at)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <TextField
                        label="信任窗口(ms)"
                        size="small"
                        type="number"
                        placeholder="可选"
                        value={grantWindows[r.id] ?? ''}
                        onChange={(e) =>
                          setGrantWindows((prev) => ({ ...prev, [r.id]: e.target.value }))
                        }
                        sx={{ width: 130 }}
                      />
                      <Button
                        size="small"
                        variant="contained"
                        color="success"
                        disabled={busyId === r.id}
                        onClick={() => handleResolve(r.id, 'approved')}
                      >
                        批准
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        color="error"
                        disabled={busyId === r.id}
                        onClick={() => handleResolve(r.id, 'rejected')}
                      >
                        拒绝
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Snackbar
        open={!!snack}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(null)} variant="filled">
            {snack.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}

export default AuthQueue;
