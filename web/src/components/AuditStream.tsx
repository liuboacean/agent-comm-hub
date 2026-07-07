import React, { useEffect, useState } from 'react';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip, Typography, Box, CircularProgress,
} from '@mui/material';
import { fetchAuditTail, type AuditEntry } from '../api';

function AuditStream(): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchAuditTail(100);
        setEntries(data);
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>审计日志</Typography>
      <TableContainer component={Paper} sx={{ maxHeight: 600 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>时间</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>操作</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>目标</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>操作者</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>详情</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow><TableCell colSpan={5} align="center">暂无审计数据</TableCell></TableRow>
            ) : (
              entries.map((e, i) => (
                <TableRow key={`${e.id}-${i}`}>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{formatTs(e.ts)}</TableCell>
                  <TableCell>{e.action}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 13 }}>{e.target}</TableCell>
                  <TableCell>{e.operator}</TableCell>
                  <TableCell>
                    <Chip label={e.details || '-'} size="small" variant="outlined"
                      color={e.details?.startsWith('fail') || e.details?.startsWith('error') ? 'error' : 'default'} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function formatTs(ts: string): string {
  try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ts; }
}

export default AuditStream;
