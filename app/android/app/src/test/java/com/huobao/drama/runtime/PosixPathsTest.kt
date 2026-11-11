package com.huobao.drama.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PosixPathsTest {
    @Test
    fun `manifest paths reject traversal and absolute forms`() {
        assertEquals("rootfs/usr/bin/node", PosixPaths.normalizeManifestPath("rootfs/usr/bin/node"))
        assertNull(PosixPaths.normalizeManifestPath("../etc/passwd"))
        assertNull(PosixPaths.normalizeManifestPath("rootfs/../etc/passwd"))
        assertNull(PosixPaths.normalizeManifestPath("/etc/passwd"))
        assertNull(PosixPaths.normalizeManifestPath("rootfs\\etc"))
        assertNull(PosixPaths.normalizeManifestPath("rootfs//bin"))
        assertNull(PosixPaths.normalizeManifestPath(""))
    }

    @Test
    fun `tar paths ignore root and leading dot`() {
        assertEquals("rootfs/usr/bin", PosixPaths.normalizeTarPath("./rootfs/usr/bin/"))
        assertNull(PosixPaths.normalizeTarPath("./"))
        assertNull(PosixPaths.normalizeTarPath("./../evil"))
        assertNull(PosixPaths.normalizeTarPath("/etc/passwd"))
    }

    @Test
    fun `absolute symlink targets are rewritten inside the container`() {
        assertEquals(
            "../../usr/bin/mawk",
            PosixPaths.resolveSymlinkTarget("rootfs/etc/alternatives/awk", "/usr/bin/mawk"),
        )
        assertEquals(
            "usr/bin",
            PosixPaths.resolveSymlinkTarget("rootfs/bin", "usr/bin"),
        )
    }

    @Test
    fun `relative symlink targets may not escape the runtime root`() {
        assertNull(
            PosixPaths.resolveSymlinkTarget(
                "rootfs/usr/bin/node",
                "../../../../etc/passwd",
            ),
        )
        assertEquals(
            "../../local/bin/node",
            PosixPaths.resolveSymlinkTarget("rootfs/usr/bin/node", "../../local/bin/node"),
        )
    }

    @Test
    fun `absolute symlink targets may not escape their top container`() {
        assertNull(PosixPaths.resolveSymlinkTarget("rootfs/etc/motd", "/../../etc/passwd"))
    }
}
