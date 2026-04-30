/**
 * utils.test.ts — 单元测试 for src/utils.ts
 * 覆盖：withRetry（重试+退避）+ requireAuth（认证+权限检查）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, requireAuth } from "../../src/utils.js";
import { checkPermission, getRequiredPermission } from "../../src/security.js";
import { logError } from "../../src/logger.js";

// ─── Mock 依赖 ──────────────────────────────────────────
vi.mock("../../src/security.js", () => ({
  checkPermission: vi.fn(),
  getRequiredPermission: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logError: vi.fn(),
}));

const mockCheckPermission = vi.mocked(checkPermission);
const mockGetRequiredPermission = vi.mocked(getRequiredPermission);
const mockLogError = vi.mocked(logError);

// ─── 测试数据 ────────────────────────────────────────────
const TEST_AUTH = { agentId: "agent_test_123", role: "member" as const };
const ADMIN_AUTH = { agentId: "agent_admin_456", role: "admin" as const };

// ═══════════════════════════════════════════════════════════
// withRetry
// ═══════════════════════════════════════════════════════════
describe("withRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return value on first successful call", async () => {
    const fn = vi.fn().mockReturnValue("ok");
    const result = await withRetry(fn, "test-label");
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("should retry and succeed on later attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockReturnValue("ok");

    // 注意：withRetry 的 fn 是同步的 () => T，不是异步
    // 修改为同步抛错
    const syncFn = vi.fn()
      .mockImplementationOnce(() => { throw new Error("fail 1"); })
      .mockImplementationOnce(() => { throw new Error("fail 2"); })
      .mockReturnValue("ok");

    const result = await withRetry(syncFn, "test-label");
    expect(result).toBe("ok");
    expect(syncFn).toHaveBeenCalledTimes(3);
    expect(mockLogError).toHaveBeenCalledTimes(2);
  });

  it("should throw after exhausting all retries", async () => {
    const error = new Error("persistent failure");
    const fn = vi.fn().mockImplementation(() => { throw error; });

    await expect(withRetry(fn, "test-label", 3)).rejects.toThrow("persistent failure");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockLogError).toHaveBeenCalledTimes(3);
  });

  it("should respect custom maxRetries=1", async () => {
    const fn = vi.fn().mockImplementation(() => { throw new Error("once"); });

    await expect(withRetry(fn, "test-label", 1)).rejects.toThrow("once");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  describe("backoff delays", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should use exponential backoff between retries", async () => {
      const fn = vi.fn()
        .mockImplementationOnce(() => { throw new Error("fail 1"); })
        .mockImplementationOnce(() => { throw new Error("fail 2"); })
        .mockReturnValue("ok");

      const promise = withRetry(fn, "test-label", 3);

      // 第 1 次失败后等待 100ms（2^0 * 100）
      await vi.advanceTimersByTimeAsync(100);
      // 第 2 次失败后等待 200ms（2^1 * 100）
      await vi.advanceTimersByTimeAsync(200);

      const result = await promise;
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// requireAuth
// ═══════════════════════════════════════════════════════════
describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should throw when authContext is undefined", () => {
    expect(() => requireAuth(undefined, "send_message")).toThrow(
      "Authentication required for tool: send_message"
    );
  });

  it("should throw when permission check fails", () => {
    mockCheckPermission.mockReturnValue(false);
    mockGetRequiredPermission.mockReturnValue("admin");

    expect(() => requireAuth(TEST_AUTH, "revoke_token")).toThrow(
      "Permission denied: revoke_token requires 'admin' role, current role is 'member'"
    );
    expect(mockCheckPermission).toHaveBeenCalledWith("revoke_token", "member");
  });

  it("should return authContext when permission check passes", () => {
    mockCheckPermission.mockReturnValue(true);

    const result = requireAuth(TEST_AUTH, "send_message");
    expect(result).toEqual(TEST_AUTH);
    expect(mockCheckPermission).toHaveBeenCalledWith("send_message", "member");
  });

  it("should default to 'member' when getRequiredPermission returns undefined", () => {
    mockCheckPermission.mockReturnValue(false);
    mockGetRequiredPermission.mockReturnValue(undefined);

    expect(() => requireAuth(TEST_AUTH, "unknown_tool")).toThrow(
      "Permission denied: unknown_tool requires 'member' role, current role is 'member'"
    );
  });

  it("should allow admin to access admin-only tools", () => {
    mockCheckPermission.mockReturnValue(true);

    const result = requireAuth(ADMIN_AUTH, "revoke_token");
    expect(result).toEqual(ADMIN_AUTH);
    expect(mockCheckPermission).toHaveBeenCalledWith("revoke_token", "admin");
  });
});
