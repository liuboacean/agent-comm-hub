import React, { useEffect, useState } from 'react';
import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip, Typography, CircularProgress, Box,
} from '@mui/material';
import { fetchStatus } from '../api';

function PipelineStatus(): React.ReactElement {
  const [pipelines, setPipelines] = useState<Array<{ state: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await fetchStatus();
        const data = Object.entries(s.pipelines.by_state).map(([state, count]) => ({ state, count }));
        setPipelines(data);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 600 }}>Pipeline 状态分布</Typography>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow><TableCell>状态</TableCell><TableCell>数量</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {pipelines.map((p) => (
              <TableRow key={p.state}>
                <TableCell><Chip label={p.state} size="small" color={p.state === 'active' ? 'success' : p.state === 'paused' ? 'warning' : 'default'} /></TableCell>
                <TableCell>{p.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export default PipelineStatus;
