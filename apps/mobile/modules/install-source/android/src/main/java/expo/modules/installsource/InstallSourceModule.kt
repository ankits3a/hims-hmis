package expo.modules.installsource

import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * WHICH APP INSTALLED THIS ONE (spec #1058). Google Play bans an app it distributes from updating itself
 * any other way, so a phone that Play installed must never be offered the hospital's own APK. Android
 * names the installer ("com.android.vending" for Google Play); null when it cannot say.
 */
class InstallSourceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HmisInstallSource")

    Function("installer") {
      val context = appContext.reactContext
      if (context == null) {
        null
      } else {
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
          } else {
            @Suppress("DEPRECATION")
            context.packageManager.getInstallerPackageName(context.packageName)
          }
        } catch (e: Exception) {
          null
        }
      }
    }
  }
}
