/* -*- Mode: c++; c-basic-offset: 4; tab-width: 20; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AndroidContentController.h"

#include "AndroidBridge.h"
#include "base/message_loop.h"
#include "mozilla/layers/APZCCallbackHelper.h"
#include "mozilla/layers/APZCTreeManager.h"
#include "nsIObserverService.h"
#include "nsLayoutUtils.h"
#include "nsWindow.h"

using mozilla::layers::APZCTreeManager;

namespace mozilla {
namespace widget {

void
AndroidContentController::Destroy()
{
    mAndroidWindow = nullptr;
    ChromeProcessController::Destroy();
}

void
AndroidContentController::NotifyDefaultPrevented(APZCTreeManager* aManager,
                                                 uint64_t aInputBlockId,
                                                 bool aDefaultPrevented)
{
    if (!AndroidBridge::IsJavaUiThread()) {
        // The notification must reach the APZ on the Java UI thread (aka the
        // APZ "controller" thread) but we get it from the Gecko thread, so we
        // have to throw it onto the other thread.
        AndroidBridge::Bridge()->PostTaskToUiThread(NewRunnableMethod(
            aManager, &APZCTreeManager::ContentReceivedInputBlock,
            aInputBlockId, aDefaultPrevented), 0);
        return;
    }

    aManager->ContentReceivedInputBlock(aInputBlockId, aDefaultPrevented);
}

void
AndroidContentController::HandleSingleTap(const CSSPoint& aPoint,
                                          Modifiers aModifiers,
                                          const ScrollableLayerGuid& aGuid)
{
    // This function will get invoked first on the Java UI thread, and then
    // again on the main thread (because of the code in ChromeProcessController::
    // HandleSingleTap). We want to post the SingleTap message once; it can be
    // done from either thread but we need access to the callback transform
    // so we do it from the main thread.
    if (NS_IsMainThread()) {
        CSSPoint point = mozilla::layers::APZCCallbackHelper::ApplyCallbackTransform(aPoint, aGuid);

        nsIContent* content = nsLayoutUtils::FindContentFor(aGuid.mScrollId);
        nsIPresShell* shell = content
            ? mozilla::layers::APZCCallbackHelper::GetRootContentDocumentPresShellForContent(content)
            : nullptr;

        if (shell && shell->ScaleToResolution()) {
            // We need to convert from the root document to the root content document,
            // by unapplying the resolution that's on the content document.
            const float resolution = shell->GetResolution();
            point.x /= resolution;
            point.y /= resolution;
        }

        CSSIntPoint rounded = RoundedToInt(point);
        nsAppShell::PostEvent([rounded] {
            nsCOMPtr<nsIObserverService> obsServ =
                mozilla::services::GetObserverService();
            if (!obsServ) {
                return;
            }

            nsPrintfCString data("{\"x\":%d,\"y\":%d}", rounded.x, rounded.y);
            obsServ->NotifyObservers(nullptr, "Gesture:SingleTap",
                                     NS_ConvertASCIItoUTF16(data).get());
        });
    }

    ChromeProcessController::HandleSingleTap(aPoint, aModifiers, aGuid);
}

void
AndroidContentController::PostDelayedTask(Task* aTask, int aDelayMs)
{
    AndroidBridge::Bridge()->PostTaskToUiThread(aTask, aDelayMs);
}
void
AndroidContentController::UpdateOverscrollVelocity(const float aX, const float aY)
{
  if (mAndroidWindow) {
    mAndroidWindow->UpdateOverscrollVelocity(aX, aY);
  }
}

void
AndroidContentController::UpdateOverscrollOffset(const float aX,const  float aY)
{
  if (mAndroidWindow) {
    mAndroidWindow->UpdateOverscrollOffset(aX, aY);
  }
}

void
AndroidContentController::NotifyAPZStateChange(const ScrollableLayerGuid& aGuid,
                                               APZStateChange aChange,
                                               int aArg)
{
  // This function may get invoked twice, if the first invocation is not on
  // the main thread then the ChromeProcessController version of this function
  // will redispatch to the main thread. We want to make sure that our handling
  // only happens on the main thread.
  ChromeProcessController::NotifyAPZStateChange(aGuid, aChange, aArg);
  if (NS_IsMainThread() && aChange == layers::GeckoContentController::APZStateChange::TransformEnd) {
    // This is used by tests to determine when the APZ is done doing whatever
    // it's doing. XXX generify this as needed when writing additional tests.
    nsCOMPtr<nsIObserverService> observerService = mozilla::services::GetObserverService();
    observerService->NotifyObservers(nullptr, "APZ:TransformEnd", nullptr);
  }
}

} // namespace widget
} // namespace mozilla
